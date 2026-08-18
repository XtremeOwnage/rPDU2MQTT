using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Integrations;
using rPDU2MQTT.Integrations.HomeAssistant;
using rPDU2MQTT.Services;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// What may make this bridge write into someone's Home Assistant Energy Dashboard.
/// <para>
/// Discovery and the dashboard are separate switches: discovery publishes over the broker this bridge
/// already has, while the dashboard is a WebSocket write into Home Assistant's own configuration. Reading
/// the integration's overall Enabled — true for discovery alone — meant the sync ran for anyone doing
/// discovery, opening a socket every pass and writing sources into a dashboard they had never turned on.
/// </para>
/// </summary>
public class HomeAssistantPublisherGatingTests
{
    private static HomeAssistantIntegration Integration(Config cfg)
        => new(cfg, new HaEnergyDashboardSync(cfg, new Snapshots()));

    private sealed class Snapshots : rPDU2MQTT.Core.ISnapshotCache
    {
        public rPDU2MQTT.Core.PduSnapshot? Latest => null;
        public rPDU2MQTT.Core.PduSnapshot? Get(string instanceId) => null;
        public IReadOnlyCollection<rPDU2MQTT.Core.PduSnapshot> All => [];
    }

    private static Config WithDiscoveryOnly()
    {
        var cfg = new Config();
        cfg.HASS.DiscoveryEnabled = true;
        cfg.HASS.EnergyDashboard.Enabled = false;
        // Credentials left over from the value source, or from having tried the dashboard once.
        cfg.HASS.EnergyDashboard.Url = "http://homeassistant.local:8123";
        cfg.HASS.EnergyDashboard.Token = "token";
        return cfg;
    }

    [Fact]
    public void DiscoveryAlone_DoesNotPublishTheDashboard()
    {
        var cfg = WithDiscoveryOnly();
        var integration = Integration(cfg);

        // Still a ready publisher (it is enabled and configured) — but nothing is due from it.
        Assert.Single(new IntegrationRegistry([integration]).Ready<IConfigurationPublisher>(cfg));
        Assert.False(integration.PublishingEnabled(cfg));

        cfg.HASS.EnergyDashboard.Enabled = true;
        Assert.True(integration.PublishingEnabled(cfg));
    }

    [Fact]
    public async Task ASyncAskedForWhileOff_WritesNothing_AndSaysSo()
    {
        // A URL and token are present, so nothing but the switch stands between this and someone's
        // dashboard. It must not reach the network at all.
        var integration = Integration(WithDiscoveryOnly());

        var published = await integration.PublishAsync(ExportPass.Build([], WithDiscoveryOnly(), null), CancellationToken.None);
        var swept = await integration.SweepAsync(ExportPass.Build([], WithDiscoveryOnly(), null), CancellationToken.None);

        Assert.Contains("off", published, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("off", swept, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void TheDashboardOn_ButUnconfigured_IsFaulted_NotPublishing()
    {
        var cfg = new Config();
        cfg.HASS.EnergyDashboard.Enabled = true;
        cfg.HASS.EnergyDashboard.Url = "";

        var integration = Integration(cfg);
        Assert.False(integration.PublishingEnabled(cfg));
        Assert.NotNull(integration.Misconfigured(cfg));
    }
}
