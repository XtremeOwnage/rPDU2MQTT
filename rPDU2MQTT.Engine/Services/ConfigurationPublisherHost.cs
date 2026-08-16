using Microsoft.Extensions.Hosting;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Core.Integrations;

namespace rPDU2MQTT.Services;

/// <summary>
/// Runs each <see cref="IConfigurationPublisher"/> on its own cadence.
///
/// <para>
/// Separate from <see cref="DestinationHost"/> because configuration is not a reading. It changes when the
/// operator changes something, so republishing it every poll is a round-trip per poll to say nothing has
/// changed — and for a retained MQTT discovery document, thousands of identical retained messages. Each
/// publisher names its own interval; the default is five minutes.
/// </para>
/// <para>
/// Always leader-gated. Two processes publishing the same discovery documents is harmless but wasteful;
/// two of them provisioning the same EmonCMS feeds races.
/// </para>
/// </summary>
public sealed class ConfigurationPublisherHost : BackgroundService
{
    private readonly Config cfg;
    private readonly IntegrationRegistry registry;
    private readonly ISnapshotCache snapshots;
    private readonly IntegrationStatus status;
    private readonly IFlowValueSource? live;
    private readonly LeaderState? leader;

    // When each publisher last ran, so they can keep different cadences off one timer.
    private readonly Dictionary<string, DateTime> lastRun = new(StringComparer.OrdinalIgnoreCase);

    public ConfigurationPublisherHost(
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
        // Ticks often; each publisher decides whether enough time has passed for it.
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(15));
        do
        {
            try { await Pass(stoppingToken); }
            catch (OperationCanceledException) { return; }
            catch (Exception ex) { Log.Error(ex, "Configuration publisher pass failed."); }
        }
        while (await SafeWait(timer, stoppingToken));
    }

    /// <summary>One pass. Public so a test can drive it without a host.</summary>
    public async Task Pass(CancellationToken ct)
    {
        if (leader is { IsLeader: false }) return;

        var due = registry.Ready<IConfigurationPublisher>(cfg)
            .Where(x => x.Capability.PublishingEnabled(cfg))
            .Where(x => !lastRun.TryGetValue(x.Integration.Id, out var last)
                        || DateTime.UtcNow - last >= x.Capability.Interval(cfg))
            .ToList();
        if (due.Count == 0) return;

        var fresh = snapshots.All
            .Where(s => !SnapshotFreshness.IsStale(s.TimestampUtc, cfg.Primary.PollInterval, DateTime.UtcNow));
        var pass = ExportPass.Build(fresh, cfg, live);

        foreach (var (integration, publisher) in due)
        {
            lastRun[integration.Id] = DateTime.UtcNow;
            try
            {
                var message = await publisher.PublishAsync(pass, ct);
                Log.Debug($"{integration.DisplayName}: {message}");
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (Exception ex)
            {
                // Recorded against this integration, not the export: a dashboard that failed to configure
                // and a reading that failed to send are different problems with different fixes.
                status.RecordFailure(integration.Id, ex.Message);
                Log.Warning($"{integration.DisplayName}: could not publish configuration — {ex.Message}");
            }
        }
    }

    /// <summary>
    /// The tick wait, with shutdown treated as an ending rather than a fault. The await used to sit in the
    /// while-condition outside the try, so cancelling on shutdown threw past the handler and the host
    /// reported a background service crash on every clean stop.
    /// </summary>
    private static async Task<bool> SafeWait(PeriodicTimer timer, CancellationToken ct)
    {
        try { return await timer.WaitForNextTickAsync(ct); }
        catch (OperationCanceledException) { return false; }
    }

}
