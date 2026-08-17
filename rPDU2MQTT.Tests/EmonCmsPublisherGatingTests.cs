using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Integrations;
using rPDU2MQTT.Integrations.EmonCms;
using rPDU2MQTT.Services;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// EmonCMS feed provisioning writes to someone else's database, so what may trigger it is the whole
/// question. These are the gates: switched off, unconfigured, or auto-configure not asked for means no pass
/// runs at all — and a refusal is not a silent one.
/// <para>
/// The gate is the publisher contract's, so a plugin publishing configuration gets the same treatment.
/// </para>
/// </summary>
public class EmonCmsPublisherGatingTests
{
    private static EmonCmsIntegration Integration(Config cfg)
        => new(cfg, new EmonCmsStatus(new IntegrationStatus()), new EmonCmsFeedSync(cfg, new Snapshots()));

    private sealed class Snapshots : rPDU2MQTT.Core.ISnapshotCache
    {
        public rPDU2MQTT.Core.PduSnapshot? Latest => null;
        public rPDU2MQTT.Core.PduSnapshot? Get(string instanceId) => null;
        public IReadOnlyCollection<rPDU2MQTT.Core.PduSnapshot> All => [];
    }

    [Fact]
    public void Disabled_IsNeverReadyToPublish()
    {
        var cfg = new Config();
        cfg.EmonCMS.Enabled = false;
        cfg.EmonCMS.Feeds.AutoConfigure = true;

        var registry = new IntegrationRegistry([Integration(cfg)]);
        Assert.Empty(registry.Ready<IConfigurationPublisher>(cfg));
    }

    [Fact]
    public void AutoConfigureOff_MeansTheTimerNeverProvisions()
    {
        var cfg = new Config();
        cfg.EmonCMS.Enabled = true;
        cfg.EmonCMS.Url = "http://emoncms.local";
        cfg.EmonCMS.ApiKey = "key";
        cfg.EmonCMS.Feeds.AutoConfigure = false;

        // Enabled, so it IS a ready publisher — but it must not run on its own when nobody asked for it.
        var integration = Integration(cfg);
        Assert.Single(new IntegrationRegistry([integration]).Ready<IConfigurationPublisher>(cfg));
        Assert.False(integration.PublishingEnabled(cfg));

        cfg.EmonCMS.Feeds.AutoConfigure = true;
        Assert.True(integration.PublishingEnabled(cfg));
    }

    [Fact]
    public void Unconfigured_IsFaulted_AndSaysWhy()
    {
        var cfg = new Config();
        cfg.EmonCMS.Enabled = true;
        cfg.EmonCMS.Url = "";
        cfg.EmonCMS.ApiKey = "";

        var faults = new IntegrationRegistry([Integration(cfg)]).Faulted(cfg);
        var (_, reason) = Assert.Single(faults);
        Assert.False(string.IsNullOrWhiteSpace(reason));
    }
}
