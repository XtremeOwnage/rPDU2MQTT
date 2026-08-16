using Microsoft.Extensions.Hosting;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Core.Integrations;

namespace rPDU2MQTT.Services;

/// <summary>
/// Builds one <see cref="ExportPass"/> per poll and offers it to every destination that is switched on.
///
/// <para>
/// This is the whole of the hosting decision that each exporter used to make for itself: the cadence, the
/// leader gate, the snapshot freshness, the flow-graph build, and what happens when one of them throws.
/// Doing it once means a new destination inherits all of it, and — the reason this exists — that the flow
/// hierarchy is assembled once and handed to everyone, so no destination can quietly omit it.
/// </para>
/// </summary>
public sealed class DestinationHost : BackgroundService
{
    private readonly Config cfg;
    private readonly IntegrationRegistry registry;
    private readonly ISnapshotCache snapshots;
    private readonly IntegrationStatus status;
    private readonly IFlowValueSource? live;
    private readonly LeaderState? leader;

    public DestinationHost(
        Config cfg, IntegrationRegistry registry, ISnapshotCache snapshots, IntegrationStatus status,
        IFlowValueSource? live = null, LeaderState? leader = null)
    {
        this.cfg = cfg;
        this.registry = registry;
        this.snapshots = snapshots;
        this.status = status;
        this.live = live;
        this.leader = leader;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var seconds = cfg.Primary.PollInterval > 0 ? cfg.Primary.PollInterval : 30;
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(seconds));

        do
        {
            try { await Pass(stoppingToken); }
            catch (OperationCanceledException) { return; }
            catch (Exception ex) { Log.Error(ex, "Destination host pass failed."); }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    /// <summary>One pass: assemble, then fan out. Public so a test can drive it without a host.</summary>
    public async Task Pass(CancellationToken ct)
    {
        // Most exporting is run-once-cluster-wide work, but not all of it: a destination whose output is
        // per-process (Prometheus serving its own /metrics) must refresh on every replica, or a scrape of a
        // non-leader returns numbers frozen at whenever it last held the lease.
        var isLeader = leader is null || leader.IsLeader;
        var ready = registry.Ready<IMeasurementDestination>(cfg)
            .Where(x => isLeader || !x.Capability.LeaderGated)
            .ToList();
        if (ready.Count == 0) return;

        var fresh = snapshots.All
            .Where(s => !SnapshotFreshness.IsStale(s.TimestampUtc, cfg.Primary.PollInterval, DateTime.UtcNow));

        var pass = ExportPass.Build(fresh, cfg, live);
        if (pass.IsEmpty) return;

        foreach (var (integration, destination) in ready)
        {
            // One failing destination has never been a reason to stop the others, and each reports against
            // its own id — a bad EmonCMS URL must not look like a Prometheus problem on the Status board.
            try
            {
                await destination.SendAsync(pass, ct);
                status.RecordSuccess(integration.Id, pass.Readings.Count);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (Exception ex)
            {
                status.RecordFailure(integration.Id, ex.Message);
                Log.Error($"{integration.DisplayName} export failed: {ex.Message}");
            }
        }
    }
}
