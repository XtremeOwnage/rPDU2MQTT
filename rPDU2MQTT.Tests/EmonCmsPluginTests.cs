using rPDU2MQTT.Classes;
using rPDU2MQTT.Core;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Core.Integrations;
using rPDU2MQTT.Plugin.EmonCms;
using rPDU2MQTT.Services;
using Xunit;

namespace rPDU2MQTT.Tests;

public class EmonCmsPluginTests
{
    private sealed class Host(Config cfg) : IPluginHost
    {
        public Config Config => cfg;
        public ISnapshotCache Snapshots { get; } = new SnapshotCache(new ChannelMessageBus());
        public IFlowValueSource? LiveValues => null;
        public IMessagePublisher? Publisher => null;
        public IntegrationStatus Status { get; } = new();
        public IPeriodAuditor? Auditor => null;
    }

    [Fact]
    public void TheBridgeShipsThePlugin_AndTheLoaderFindsBothIntegrations()
    {
        var bridge = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "rPDU2MQTT", "bin"));
        var built = Directory.Exists(bridge)
            ? Directory.EnumerateFiles(bridge, "rPDU2MQTT.Plugin.EmonCms.dll", SearchOption.AllDirectories).FirstOrDefault(f => f.Contains(Path.Combine("bundled-plugins", "emoncms")))
            : null;
        Assert.True(built is not null, "the bridge's build did not copy the EmonCMS plugin into bundled-plugins/emoncms/");
        var ids = Plugins.PluginLoader.Load(Path.GetDirectoryName(built)).SelectMany(p => p.Integrations).Select(i => i.Id).ToList();
        Assert.Contains("emoncms", ids);
        Assert.Contains("emoncms-source", ids);
    }

    [Fact]
    public void TheCatalog_DescribesThePlugin_AndWhatItsIntegrationsProvide()
    {
        var bridge = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "rPDU2MQTT", "bin"));
        var built = Directory.EnumerateFiles(bridge, "rPDU2MQTT.Plugin.EmonCms.dll", SearchOption.AllDirectories).First(f => f.Contains(Path.Combine("bundled-plugins", "emoncms")));
        var found = Plugins.PluginLoader.Load(Path.GetDirectoryName(built)).Select(p => p with { Key = "emoncms", Bundled = true }).ToList();

        var listed = Assert.Single(new Plugins.PluginCatalog(found).Plugins);

        Assert.Equal("EmonCMS", listed.Name);
        Assert.False(string.IsNullOrWhiteSpace(listed.Description));
        foreach (var capability in new[] { "destination", "history", "values" })
            Assert.Contains(capability, listed.Capabilities!);
    }

    [Fact]
    public void UseHost_ReadsTheHostsConfig()
    {
        var cfg = new Config();
        cfg.EmonCMS.Enabled = true;
        cfg.EmonCMS.Url = null;
        var plugin = new EmonCmsIntegration();
        var host = new Host(cfg);

        plugin.UseHost(host);

        Assert.True(plugin.Enabled(cfg));
        Assert.NotNull(plugin.Misconfigured(cfg));
        Assert.Equal(HealthLevel.Bad, plugin.Status(cfg).Level);
        host.Status.RecordSuccess("emoncms", 3);
        cfg.EmonCMS.Url = "http://emoncms.example.com";
        Assert.Equal(HealthLevel.Good, plugin.Status(cfg).Level);
    }

    [Fact]
    public void TheHistoryRouter_ReadsAndCopiesThroughThePlugin()
    {
        var cfg = new Config();
        cfg.History.Enabled = true;
        cfg.History.Provider = "emoncms";
        var plugin = new EmonCmsIntegration();
        plugin.UseHost(new Host(cfg));

        var router = new FlowHistoryRouter(new HttpClient(), cfg, plugins: [plugin]);

        Assert.Equal("emoncms", router.Id);
        Assert.IsType<EmonCmsFlowHistory>(router.Backends["emoncms"]);
        Assert.Equal("EmonCMS.Url is not set", plugin.HistoryUnavailable(cfg));
        Assert.IsType<EmonCmsHistoryTarget>(plugin.CreateHistoryTarget(new HttpClient(), cfg));
    }

    [Fact]
    public void WithoutThePlugin_EmonCmsIsNotAHistoryBackend()
    {
        var cfg = new Config();
        cfg.History.Provider = "emoncms";

        var router = new FlowHistoryRouter(new HttpClient(), cfg);

        Assert.DoesNotContain("emoncms", router.Backends.Keys);
        Assert.Equal("prometheus", router.Id);
    }
}
