using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Integrations;
using rPDU2MQTT.Services;

namespace rPDU2MQTT.Integrations.HomeAssistant;

/// <summary>
/// Home Assistant: everything this bridge tells HA about itself — the MQTT discovery documents describing
/// each device and entity, and the Energy Dashboard's own configuration pushed over HA's WebSocket API
/// (#128).
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
public sealed class HomeAssistantIntegration : IIntegration, IConfigurationPublisher, IStatusProvider
{
    private readonly Config cfg;
    private readonly HaEnergyDashboardSync sync;
    // Discovery is published by its own long-standing service; this triggers and clears it, so both halves
    // of "what HA knows about us" answer to one integration instead of two unrelated buttons.
    private readonly DiscoveryCoordinator? discovery;

    public HomeAssistantIntegration(Config cfg, HaEnergyDashboardSync sync, DiscoveryCoordinator? discovery = null)
    {
        this.cfg = cfg;
        this.sync = sync;
        this.discovery = discovery;
    }

    public string Id => "homeassistant";
    public string DisplayName => "Home Assistant";
    public IntegrationGroup Group => IntegrationGroup.Destinations;

    public bool Enabled(Config c) => c.HASS.DiscoveryEnabled || c.HASS.EnergyDashboard.Enabled;

    public string? Misconfigured(Config c)
    {
        var ed = c.HASS.EnergyDashboard;
        // Discovery needs nothing but the broker this bridge already has, so only the dashboard can be
        // misconfigured — and only when it is the part that is switched on.
        if (!ed.Enabled) return null;
        // Both messages name the page that has the field. These settings are not on the Home Assistant page
        // — they have their own — and a fault that names neither sends the operator to the wrong one.
        if (string.IsNullOrWhiteSpace(ed.Url))
            return "The Energy Dashboard sync is enabled but no Home Assistant URL is set. Set it on the HA Energy Mapping page.";
        if (string.IsNullOrWhiteSpace(ed.Token))
            return "The Energy Dashboard sync is enabled but no long-lived access token is set. Set it on the HA Energy Mapping page.";
        return null;
    }

    /// <summary>
    /// Slower than the export: the dashboard's configuration changes when the operator changes something,
    /// not every poll. Pushing it at the export cadence would be a WebSocket round-trip per poll to say
    /// nothing has changed.
    /// </summary>
    public TimeSpan Interval(Config c) => TimeSpan.FromSeconds(Math.Max(30, c.Primary.PollInterval * 4));

    /// <summary>
    /// The configuration this integration publishes is the Energy Dashboard, so it is the dashboard's own
    /// switch that governs — not <see cref="Enabled"/>, which is also true for discovery. Reading the wrong
    /// one meant a bridge doing discovery only still opened a WebSocket to Home Assistant every pass and
    /// wrote energy sources into a dashboard nobody had turned on (or, with no URL configured, logged a
    /// failure every pass forever).
    /// </summary>
    public bool PublishingEnabled(Config c) => c.HASS.EnergyDashboard.Enabled && Misconfigured(c) is null;

    /// <summary>
    /// Configured is as far as this can honestly go without calling Home Assistant, and calling it belongs
    /// in the probe an operator triggers, not in a card refreshed on a timer.
    /// </summary>
    public IntegrationHealth Status(Config c)
    {
        if (!Enabled(c)) return new(HealthLevel.Off, "Off");
        if (Misconfigured(c) is { } fault) return new(HealthLevel.Bad, "Misconfigured", fault);

        var parts = new List<string>();
        if (c.HASS.DiscoveryEnabled) parts.Add($"discovery → {c.HASS.DiscoveryTopic}");
        if (c.HASS.EnergyDashboard.Enabled) parts.Add($"energy dashboard → {c.HASS.EnergyDashboard.Url}");
        return new(HealthLevel.Good, "On", string.Join(" · ", parts));
    }

    public async Task<string> PublishAsync(ExportPass pass, CancellationToken ct)
    {
        var ed = cfg.HASS.EnergyDashboard;
        // Checked here too: a caller that reaches this without asking must not write to someone's dashboard.
        if (!ed.Enabled) return "The Home Assistant Energy Dashboard sync is off.";
        var n = await sync.SyncAsync(ed.Url!, ed.Token!, ct);
        return $"Synced {n} energy source(s) into the Home Assistant Energy Dashboard.";
    }

    /// <summary>Take this bridge's sources back out of the dashboard, leaving anything HA owns alone.</summary>
    public async Task<string> SweepAsync(ExportPass pass, CancellationToken ct)
    {
        var ed = cfg.HASS.EnergyDashboard;
        if (!ed.Enabled) return "The Home Assistant Energy Dashboard sync is off.";
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
