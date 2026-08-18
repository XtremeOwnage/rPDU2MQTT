using rPDU2MQTT.Classes;
using rPDU2MQTT.Core;
using rPDU2MQTT.Core.Integrations;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Models.PDU;
using rPDU2MQTT.Services;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// The one poll loop: read each device on that device's own cadence, publish what it read onto the bus
/// everything downstream listens to, and treat "nothing to report" as silence rather than as a reading of
/// zero.
/// </summary>
public class DevicePollServiceTests
{
    private sealed class Reader : IDeviceReader
    {
        public int Reads;
        public PduData? Next = new();
        public Exception? Throw;
        public TimeSpan Every = TimeSpan.FromSeconds(30);

        public bool Handles(string instanceId, Config cfg) => true;
        public TimeSpan Interval(string instanceId, Config cfg) => Every;

        public Task<PduData?> ReadAsync(string instanceId, Config cfg, CancellationToken ct)
        {
            Reads++;
            if (Throw is not null) throw Throw;
            return Task.FromResult(Next);
        }
    }

    private static Config Config(params string[] pdus)
    {
        var cfg = new Config();
        cfg.Pdus.Clear();
        foreach (var id in pdus)
        {
            var pdu = new PduConfig();
            pdu.Connection.Host = "10.0.0.1";
            cfg.Pdus[id] = pdu;
        }
        return cfg;
    }

    private static (DevicePollService Service, Reader Reader, List<PduSnapshot> Published) Build(Config cfg)
    {
        var reader = new Reader();
        var bus = new ChannelMessageBus();
        var published = new List<PduSnapshot>();
        var stream = bus.Subscribe();
        var pump = Task.Run(async () => { await foreach (var s in stream) lock (published) published.Add(s); });

        var service = new DevicePollService(cfg, [reader], bus, new HealthState(), new IntegrationStatus());
        return (service, reader, published);
    }

    private static async Task<IReadOnlyList<PduSnapshot>> Settle(List<PduSnapshot> published)
    {
        // The bus is a channel with a reader on another task; give it a moment to drain.
        for (var i = 0; i < 50; i++)
        {
            lock (published) if (published.Count > 0) return published.ToList();
            await Task.Delay(10);
        }
        lock (published) return published.ToList();
    }

    [Fact]
    public async Task EachConfiguredDevice_IsRead_AndItsSnapshotPublished()
    {
        var (service, reader, published) = Build(Config("rack-a", "rack-b"));

        await service.Poll(CancellationToken.None);

        Assert.Equal(2, reader.Reads);
        var snapshots = await Settle(published);
        Assert.Equal(["rack-a", "rack-b"], snapshots.Select(s => s.InstanceId).OrderBy(x => x));
    }

    [Fact]
    public async Task ADeviceIsNotReRead_UntilItsOwnIntervalHasPassed()
    {
        var (service, reader, _) = Build(Config("rack-a"));
        reader.Every = TimeSpan.FromMinutes(5);

        await service.Poll(CancellationToken.None);
        await service.Poll(CancellationToken.None);
        await service.Poll(CancellationToken.None);

        Assert.Equal(1, reader.Reads);
    }

    [Fact]
    public async Task NothingToReport_PublishesNothing_RatherThanASnapshotOfZeros()
    {
        // The distinction the whole poll turns on: a device that answered "nothing" must leave the previous
        // snapshot to go stale — which is what marks it unavailable — not publish an empty one, which every
        // destination downstream would read as every outlet having gone to zero.
        var (service, reader, published) = Build(Config("rack-a"));
        reader.Next = null;

        await service.Poll(CancellationToken.None);

        await Task.Delay(50);
        lock (published) Assert.Empty(published);
    }

    [Fact]
    public async Task AFailedRead_PublishesNothing_AndIsRecordedAgainstThatDevice()
    {
        var cfg = Config("rack-a");
        var reader = new Reader { Throw = new Exception("connection refused") };
        var bus = new ChannelMessageBus();
        var status = new IntegrationStatus();
        var published = new List<PduSnapshot>();
        var stream = bus.Subscribe();
        _ = Task.Run(async () => { await foreach (var s in stream) lock (published) published.Add(s); });

        var service = new DevicePollService(cfg, [reader], bus, new HealthState(), status);
        await service.Poll(CancellationToken.None);   // the failure is handled, not thrown at the loop

        await Task.Delay(50);
        lock (published) Assert.Empty(published);
        Assert.Equal("connection refused", status.For("rack-a")?.LastError);
    }
}
