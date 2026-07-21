using Microsoft.Extensions.Hosting;
using rPDU2MQTT.Classes;

namespace rPDU2MQTT.Services;

/// <summary>
/// Periodically re-pushes the energy-flow hierarchy into HA's Energy Dashboard (#128) while
/// <c>HomeAssistant.EnergyDashboard.Enabled</c> is on — the live toggle from the HA Energy Mapping page.
/// The manual "Sync now"/"Clear" buttons use the same <see cref="HaEnergyDashboardSync"/>.
/// </summary>
public sealed class HaEnergyDashboardService : BackgroundService
{
    private readonly Config config;
    private readonly HaEnergyDashboardSync sync;
    private readonly Core.LeaderState? leader;

    public HaEnergyDashboardService(Config config, HaEnergyDashboardSync sync, Core.LeaderState? leader = null)
    {
        this.config = config;
        this.sync = sync;
        this.leader = leader;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var period = TimeSpan.FromSeconds(Math.Max(30, config.Primary.PollInterval * 4));
        using var timer = new PeriodicTimer(period);
        do
        {
            var ed = config.HASS.EnergyDashboard;
            // v3: run-once cluster-wide — only the leader pushes to HA.
            if (leader is { IsLeader: false }) continue;
            if (ed.Enabled && !string.IsNullOrWhiteSpace(ed.Url) && !string.IsNullOrWhiteSpace(ed.Token))
            {
                try { await sync.SyncAsync(ed.Url!, ed.Token!, stoppingToken); }
                catch (OperationCanceledException) { return; }
                catch (Exception ex) { Log.Warning($"HA Energy Dashboard sync failed: {ex.Message}"); }
            }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }
}
