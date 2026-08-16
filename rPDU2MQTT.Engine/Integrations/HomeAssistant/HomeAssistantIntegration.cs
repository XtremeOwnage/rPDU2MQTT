using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Integrations;
using rPDU2MQTT.Services;

namespace rPDU2MQTT.Integrations.HomeAssistant;

/// <summary>
/// Home Assistant's Energy Dashboard: the hierarchy pushed in as grid / solar / battery / device sources
/// over HA's WebSocket API (#128).
///
/// <para>
/// Purely a configuration publisher, and the clearest case for that contract existing: this never sends a
/// reading. It writes the dashboard's own configuration — which statistic is the grid, which is production,
/// which device sits under which — and the measurements that populate it arrive separately, over MQTT, from
/// discovery. Modelling it as a destination would have meant a destination whose <c>SendAsync</c> ignored
/// everything it was sent.
/// </para>
/// <para>
/// Its failure mode is the one that justifies the split too: a missed measurement is a gap in a chart, but a
/// dashboard configured against the wrong statistic is wrong in a way nobody notices until the monthly
/// figures do not add up.
/// </para>
/// </summary>
public sealed class HomeAssistantIntegration : IIntegration, IConfigurationPublisher
{
    private readonly Config cfg;
    private readonly HaEnergyDashboardSync sync;

    public HomeAssistantIntegration(Config cfg, HaEnergyDashboardSync sync)
    {
        this.cfg = cfg;
        this.sync = sync;
    }

    public string Id => "homeassistant";
    public string DisplayName => "Home Assistant";
    public IntegrationGroup Group => IntegrationGroup.Destinations;

    public bool Enabled(Config c) => c.HASS.EnergyDashboard.Enabled;

    public string? Misconfigured(Config c)
    {
        var ed = c.HASS.EnergyDashboard;
        if (!ed.Enabled) return null;
        if (string.IsNullOrWhiteSpace(ed.Url)) return "The Energy Dashboard sync is enabled but HomeAssistant.EnergyDashboard.Url is not set.";
        if (string.IsNullOrWhiteSpace(ed.Token)) return "The Energy Dashboard sync is enabled but no long-lived access token is set.";
        return null;
    }

    /// <summary>
    /// Slower than the export: the dashboard's configuration changes when the operator changes something,
    /// not every poll. Pushing it at the export cadence would be a WebSocket round-trip per poll to say
    /// nothing has changed.
    /// </summary>
    public TimeSpan Interval(Config c) => TimeSpan.FromSeconds(Math.Max(30, c.Primary.PollInterval * 4));

    public bool PublishingEnabled(Config c) => Enabled(c) && Misconfigured(c) is null;

    public async Task<string> PublishAsync(ExportPass pass, CancellationToken ct)
    {
        var ed = cfg.HASS.EnergyDashboard;
        var n = await sync.SyncAsync(ed.Url!, ed.Token!, ct);
        return $"Synced {n} energy source(s) into the Home Assistant Energy Dashboard.";
    }

    /// <summary>Take this bridge's sources back out of the dashboard, leaving anything HA owns alone.</summary>
    public async Task<string> SweepAsync(ExportPass pass, CancellationToken ct)
    {
        var ed = cfg.HASS.EnergyDashboard;
        if (Misconfigured(cfg) is { } why) return why;
        var n = await sync.ClearAsync(ed.Url!, ed.Token!, ct);
        return $"Removed {n} energy source(s) from the Home Assistant Energy Dashboard.";
    }

    public async Task<(bool Ok, string Detail)> ProbeAsync(Config c, CancellationToken ct)
    {
        if (Misconfigured(c) is { } why) return (false, why);
        try
        {
            var n = await sync.SyncAsync(c.HASS.EnergyDashboard.Url!, c.HASS.EnergyDashboard.Token!, ct);
            return (true, $"reachable — {n} energy source(s) mapped");
        }
        catch (Exception ex) { return (false, ex.Message); }
    }
}
