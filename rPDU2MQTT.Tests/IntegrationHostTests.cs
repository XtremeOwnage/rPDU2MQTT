using rPDU2MQTT.Classes;
using rPDU2MQTT.Core;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Core.Integrations;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Models.PDU;
using rPDU2MQTT.Services;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// The hosts that drive the integration contracts. These decide when each capability runs, who runs it, and
/// what happens when one of them fails — the parts every integration inherits and therefore the parts
/// nobody tests per integration.
/// </summary>
public class IntegrationHostTests
{
    // --- Doubles ---------------------------------------------------------------------------------------

    private sealed class Recorder : IIntegration, IMeasurementDestination
    {
        public Recorder(string id, bool leaderGated = true, Exception? throws = null)
        {
            Id = id;
            LeaderGated = leaderGated;
            Throws = throws;
        }

        public string Id { get; }
        public string DisplayName => Id;
        public IntegrationGroup Group => IntegrationGroup.Destinations;
        public bool Enabled(Config cfg) => true;

        public bool LeaderGated { get; }
        public Exception? Throws { get; }

        public int Calls;
        public ExportPass? Last;

        public Task SendAsync(ExportPass pass, CancellationToken ct)
        {
            Calls++;
            Last = pass;
            return Throws is null ? Task.CompletedTask : Task.FromException(Throws);
        }
    }

    private sealed class Publisher : IIntegration, IConfigurationPublisher
    {
        public string Id => "publisher";
        public string DisplayName => "Publisher";
        public IntegrationGroup Group => IntegrationGroup.Destinations;
        public bool Enabled(Config cfg) => true;

        public TimeSpan Every = TimeSpan.FromMinutes(5);
        public int Calls;

        public bool PublishingEnabled(Config cfg) => true;
        public TimeSpan Interval(Config cfg) => Every;
        public Task<string> PublishAsync(ExportPass pass, CancellationToken ct) { Calls++; return Task.FromResult("done"); }
    }

    private sealed class Snapshots : ISnapshotCache
    {
        private readonly List<PduSnapshot> all = [];
        public Snapshots(params PduSnapshot[] s) => all.AddRange(s);
        public IReadOnlyCollection<PduSnapshot> All => all;
        public PduSnapshot? Latest => all.LastOrDefault();
        public PduSnapshot? Get(string id) => all.FirstOrDefault(s => s.InstanceId == id);
    }

    private static PduSnapshot Snapshot(string instance = "default", double watts = 60, DateTime? at = null)
    {
        var outlet = new Outlet { Key = 0, Entity_Name = "o0", Entity_DisplayName = "Outlet 1" };
        outlet.Measurements.Add(new Measurement { Type = "realpower", Value = watts.ToString(), Units = "W" });
        var device = new Device { Key = "d", Entity_Name = "pdu_1", Entity_DisplayName = "PDU 1" };
        device.Outlets.Add(outlet);
        var data = new PduData();
        data.Devices.Add(device);
        return new PduSnapshot(instance, at ?? DateTime.UtcNow, data);
    }

    private static Config Configured()
    {
        var c = new Config();
        c.Pdus["default"] = new PduConfig { PollInterval = 30 };
        return c;
    }

    // --- DestinationHost -------------------------------------------------------------------------------

    [Fact]
    public async Task OnePassIsBuiltAndSharedByEveryDestination()
    {
        // The reason ExportPass exists: assembled once, so two destinations cannot be given different
        // views of the world, and the flow graph is built once per poll rather than once per destination.
        var a = new Recorder("a");
        var b = new Recorder("b");
        var host = new DestinationHost(Configured(), new IntegrationRegistry([a, b]), new Snapshots(Snapshot()), new IntegrationStatus());

        await host.Pass(CancellationToken.None);

        Assert.Same(a.Last, b.Last);
        Assert.Equal(1, a.Calls);
        Assert.Equal(1, b.Calls);
    }

    [Fact]
    public async Task AFailingDestination_DoesNotStopTheOthers_AndIsRecordedAgainstItself()
    {
        // A bad EmonCMS URL must not look like a Prometheus problem, and must not stop Prometheus running.
        var bad = new Recorder("bad", throws: new InvalidOperationException("connection refused"));
        var good = new Recorder("good");
        var status = new IntegrationStatus();
        var host = new DestinationHost(Configured(), new IntegrationRegistry([bad, good]), new Snapshots(Snapshot()), status);

        await host.Pass(CancellationToken.None);

        Assert.Equal(1, good.Calls);
        Assert.False(status.For("bad")!.LastOk);
        Assert.Equal("connection refused", status.For("bad")!.LastError);
        Assert.True(status.For("good")!.LastOk);
    }

    [Fact]
    public async Task OnANonLeader_OnlyPerProcessDestinationsRun()
    {
        // Prometheus serves its own /metrics on every replica, so gating it on leadership would leave a
        // scrape of any other pod reading numbers frozen at whenever it last held the lease.
        var shared = new Recorder("shared", leaderGated: true);
        var perProcess = new Recorder("per-process", leaderGated: false);
        var host = new DestinationHost(Configured(), new IntegrationRegistry([shared, perProcess]),
            new Snapshots(Snapshot()), new IntegrationStatus(), leader: new LeaderState { IsLeader = false });

        await host.Pass(CancellationToken.None);

        Assert.Equal(0, shared.Calls);
        Assert.Equal(1, perProcess.Calls);
    }

    [Fact]
    public async Task AStaleSnapshotIsNotExported()
    {
        // A PDU that stopped answering must age out rather than being republished as current — that is what
        // lets Home Assistant's expire_after mark its entities unavailable.
        var a = new Recorder("a");
        var stale = Snapshot(at: DateTime.UtcNow.AddHours(-1));
        var host = new DestinationHost(Configured(), new IntegrationRegistry([a]), new Snapshots(stale), new IntegrationStatus());

        await host.Pass(CancellationToken.None);

        Assert.Equal(0, a.Calls);   // nothing fresh, and no hierarchy configured, so there is nothing to send
    }

    [Fact]
    public async Task EachReadingKeepsTheInstanceItCameFrom()
    {
        // Merging every instance into one snapshot loses the only thing the Prometheus `instance` label is
        // built from.
        var a = new Recorder("a");
        var host = new DestinationHost(Configured(), new IntegrationRegistry([a]),
            new Snapshots(Snapshot("first"), Snapshot("second")), new IntegrationStatus());

        await host.Pass(CancellationToken.None);

        Assert.Equal(["first", "second"], a.Last!.Readings.Select(r => r.InstanceId).Distinct().Order());
        // And unmerged snapshots survive, because a device must be stamped with its OWN poll time.
        Assert.Equal(2, a.Last!.Snapshots.Count);
    }

    // --- ConfigurationPublisherHost --------------------------------------------------------------------

    [Fact]
    public async Task ConfigurationIsPublishedOnItsOwnCadence_NotEveryPoll()
    {
        // Republishing configuration every poll is a round-trip per poll to say nothing changed, and for a
        // retained discovery document it is thousands of identical retained messages.
        var publisher = new Publisher { Every = TimeSpan.FromMinutes(5) };
        var host = new ConfigurationPublisherHost(Configured(), new IntegrationRegistry([publisher]),
            new Snapshots(Snapshot()), new IntegrationStatus());

        await host.Pass(CancellationToken.None);
        await host.Pass(CancellationToken.None);
        await host.Pass(CancellationToken.None);

        Assert.Equal(1, publisher.Calls);
    }

    [Fact]
    public async Task ConfigurationIsNeverPublishedFromANonLeader()
    {
        // Two processes provisioning the same EmonCMS feeds races into duplicates.
        var publisher = new Publisher();
        var host = new ConfigurationPublisherHost(Configured(), new IntegrationRegistry([publisher]),
            new Snapshots(Snapshot()), new IntegrationStatus(), leader: new LeaderState { IsLeader = false });

        await host.Pass(CancellationToken.None);

        Assert.Equal(0, publisher.Calls);
    }

    // --- The single-owner lease ------------------------------------------------------------------------

    [Fact]
    public async Task TheSoleOwnerLease_AlwaysRuns_BecauseThereIsNobodyElse()
    {
        var ran = false;
        var owned = await new SoleOwnerLease().RunIfOwnerAsync("k", _ => { ran = true; return Task.CompletedTask; }, CancellationToken.None);

        Assert.True(owned);
        Assert.True(ran);
    }

    // --- Health derivation -----------------------------------------------------------------------------

    [Fact]
    public void ADisabledIntegration_IsNotAProblem()
    {
        // A minimal install is not a degraded system, and colouring "off" like a fault trains people to
        // ignore the board.
        var off = new Recorder("off");
        var cfg = new Config();
        var health = IntegrationHealthDefaults.For(new AlwaysOff(), cfg, null);

        Assert.Equal(HealthLevel.Off, health.Level);
    }

    private sealed class AlwaysOff : IIntegration
    {
        public string Id => "off";
        public string DisplayName => "Off";
        public IntegrationGroup Group => IntegrationGroup.Destinations;
        public bool Enabled(Config cfg) => false;
    }

    private sealed class OwnOpinion : IIntegration, IStatusProvider
    {
        public string Id => "own";
        public string DisplayName => "Own";
        public IntegrationGroup Group => IntegrationGroup.Destinations;
        public bool Enabled(Config cfg) => true;
        public IntegrationHealth Status(Config cfg) => new(HealthLevel.Warn, "Only I know", "because it is about me");
    }

    [Fact]
    public void AnIntegrationWithItsOwnOpinion_Wins_OverTheSharedDerivation()
    {
        // The whole point of IStatusProvider: the verdict belongs to the thing it is about. The shared
        // derivation would have called this one Good, having seen a successful pass.
        var status = new IntegrationStatus();
        status.RecordSuccess("own", 5);

        var health = IntegrationHealthDefaults.For(new OwnOpinion(), new Config(), status.For("own"));

        Assert.Equal(HealthLevel.Warn, health.Level);
        Assert.Equal("Only I know", health.Summary);
    }
}
