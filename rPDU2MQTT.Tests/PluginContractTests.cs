using System.ComponentModel;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Integrations;
using rPDU2MQTT.Services.Gui;
using Xunit;

namespace rPDU2MQTT.Tests;

public class PluginContractTests
{
    private sealed class ExampleSettings
    {
        [DefaultValue(false)]
        [Description("Write every reading to a file.")]
        public bool Enabled { get; set; }

        [DefaultValue("/tmp/out.txt")]
        [Description("Where to write it.")]
        public string Path { get; set; } = "/tmp/out.txt";

        [DefaultValue(30)]
        public int IntervalSeconds { get; set; } = 30;
    }

    private sealed class ExamplePlugin : IIntegration, IMeasurementDestination, IConfigurablePlugin, IIntegrationApi
    {
        public ExampleSettings Settings = new();
        public ExportPass? Received;

        public string Id => "example";
        public string DisplayName => "Example";
        public IntegrationGroup Group => IntegrationGroup.Destinations;
        public bool Enabled(Config cfg) => Settings.Enabled;

        public Type ConfigType => typeof(ExampleSettings);
        public void ApplyConfig(object s) => Settings = (ExampleSettings)s;

        public Task SendAsync(ExportPass pass, CancellationToken ct) { Received = pass; return Task.CompletedTask; }

        public IReadOnlyList<IntegrationAction> Actions =>
        [
            new("peek", "Peek", "Show what was received.", ActionEffect.Read,
                (ctx, ct) => Task.FromResult<object?>(new { node = ctx.Arg("node"), count = Received?.Readings.Count ?? 0 })),
        ];
    }

    /// <summary>Mimics YAML loader output: boxed-key dictionaries with string scalars.</summary>
    private static Dictionary<string, object?> YamlSection(params (string Key, object Value)[] fields)
    {
        var inner = new Dictionary<object, object>();
        foreach (var (k, v) in fields) inner[k] = v;
        return new Dictionary<string, object?> { ["example"] = inner };
    }

    [Theory]
    [InlineData("""{ "Plugins": { "example": { "Enabled": true, "IntervalSeconds": "" } } }""")]
    [InlineData("""{ "Plugins": { "example": { "Enabled": true, "IntervalSeconds": null } } }""")]
    public void ABlankField_KeepsItsDefault(string json)
    {
        var plugin = new ExamplePlugin();
        var warnings = new List<string>();
        PluginConfigBinder.Bind(plugin, "example", ConfigSchema.FromJson(json).Plugins!, warnings.Add);

        Assert.Empty(warnings);
        Assert.True(plugin.Settings.Enabled);
        Assert.Equal(30, plugin.Settings.IntervalSeconds);
    }

    [Fact]
    public void APluginBindsItsOwnSettings_FromWhatYamlProduced()
    {
        var plugin = new ExamplePlugin();
        var sections = YamlSection(("Enabled", "true"), ("Path", "/var/log/x.txt"), ("IntervalSeconds", "10"));

        PluginConfigBinder.Bind(plugin, "example", sections);

        Assert.True(plugin.Settings.Enabled);
        Assert.Equal("/var/log/x.txt", plugin.Settings.Path);
        Assert.Equal(10, plugin.Settings.IntervalSeconds);
    }

    [Fact]
    public void APluginBindsItsOwnSettings_FromAJsonConfig()
    {
        var plugin = new ExamplePlugin();
        var cfg = ConfigSchema.FromJson("""{ "Plugins": { "example": { "Enabled": true, "Path": "/var/log/x.txt", "IntervalSeconds": 10 } } }""");

        PluginConfigBinder.Bind(plugin, "example", cfg.Plugins!);

        Assert.True(plugin.Settings.Enabled);
        Assert.Equal("/var/log/x.txt", plugin.Settings.Path);
        Assert.Equal(10, plugin.Settings.IntervalSeconds);
    }

    [Fact]
    public void AnUnreadableSection_LeavesThePluginOnDefaults_AndDoesNotThrow()
    {
        var plugin = new ExamplePlugin();
        var warnings = new List<string>();
        var sections = new Dictionary<string, object?> { ["example"] = "not an object" };

        PluginConfigBinder.Bind(plugin, "example", sections, warnings.Add);

        Assert.False(plugin.Settings.Enabled);
        Assert.Equal("/tmp/out.txt", plugin.Settings.Path);
        Assert.Single(warnings);
    }

    [Fact]
    public void APluginsSettingsClass_BecomesARenderedPage()
    {
        var plugin = new ExamplePlugin();
        var schema = ConfigSchema.Build([(plugin.Id, plugin.DisplayName, plugin.ConfigType, plugin.Group.ToString())]);

        var section = schema.Single(n => n.Key == "example");
        Assert.True(section.IsPlugin);
        Assert.Equal("Destinations", section.Group);
        Assert.Equal("bool", section.Properties!.Single(p => p.Key == "Enabled").Type);
        Assert.Equal("int", section.Properties!.Single(p => p.Key == "IntervalSeconds").Type);
        Assert.Equal("Where to write it.", section.Properties!.Single(p => p.Key == "Path").Description);
    }

    [Fact]
    public void CapabilitiesImplyTheirActions_AndDeclaredOnesAreAddedToThem()
    {
        var plugin = new ExamplePlugin();
        var actions = IntegrationActions.For(plugin);

        Assert.Contains(actions, a => a.Name == IntegrationActions.Probe);
        Assert.Contains(actions, a => a.Name == "peek");
        Assert.DoesNotContain(actions, a => a.Name == IntegrationActions.Publish);
        Assert.DoesNotContain(actions, a => a.Name == IntegrationActions.Sweep);
    }

    [Fact]
    public async Task AnActionReceivesItsArguments_AndNeverAnHttpContext()
    {
        var plugin = new ExamplePlugin();
        var action = IntegrationActions.Find(plugin, "peek")!;

        var result = await action.Handler(
            new IntegrationActionContext(new Config(), new Dictionary<string, string?> { ["node"] = "solar" }),
            CancellationToken.None);

        Assert.Contains("solar", result!.ToString());
    }

    [Fact]
    public void APluginsHealth_IsDerivedWithoutItImplementingAnything()
    {
        var plugin = new ExamplePlugin();
        var cfg = new Config();
        var status = new IntegrationStatus();

        Assert.Equal(HealthLevel.Off, IntegrationHealthDefaults.For(plugin, cfg, status.For(plugin.Id)).Level);

        plugin.Settings.Enabled = true;
        Assert.Equal(HealthLevel.Warn, IntegrationHealthDefaults.For(plugin, cfg, status.For(plugin.Id)).Level);

        status.RecordSuccess(plugin.Id, 12);
        Assert.Equal(HealthLevel.Good, IntegrationHealthDefaults.For(plugin, cfg, status.For(plugin.Id)).Level);

        status.RecordFailure(plugin.Id, "connection refused");
        var bad = IntegrationHealthDefaults.For(plugin, cfg, status.For(plugin.Id));
        Assert.Equal(HealthLevel.Bad, bad.Level);
        Assert.Equal("connection refused", bad.Detail);
    }

    [Fact]
    public void TheRegistryFindsAPluginsCapabilities_AndItsActionsByName()
    {
        var registry = new IntegrationRegistry([new ExamplePlugin()]);

        Assert.Equal(["destination", "actions"], IntegrationRegistry.Capabilities(registry.ById("example")!));
        Assert.NotNull(registry.Action("example", "peek"));
        Assert.NotNull(registry.Action("EXAMPLE", "PEEK"));
        Assert.Null(registry.Action("example", "nope"));
    }
}
