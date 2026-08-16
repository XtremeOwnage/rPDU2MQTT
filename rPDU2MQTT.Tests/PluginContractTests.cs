using System.ComponentModel;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Integrations;
using rPDU2MQTT.Services.Gui;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// The plugin contract as an author meets it: declare an id and a settings class, get configuration,
/// a rendered page, actions and health without writing any of them.
/// </summary>
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

    /// <summary>The YAML loader's shape: nested dictionaries with boxed keys, every scalar a string.</summary>
    private static Dictionary<string, object?> YamlSection(params (string Key, object Value)[] fields)
    {
        var inner = new Dictionary<object, object>();
        foreach (var (k, v) in fields) inner[k] = v;
        return new Dictionary<string, object?> { ["example"] = inner };
    }

    [Fact]
    public void APluginBindsItsOwnSettings_FromWhatYamlProduced()
    {
        // Every scalar arrives as a string. Binding "true" to a bool and "10" to an int is what makes an
        // ordinary settings class work at all — without it every bool and number silently kept its default,
        // so a plugin an operator had switched on simply never ran.
        var plugin = new ExamplePlugin();
        var sections = YamlSection(("Enabled", "true"), ("Path", "/var/log/x.txt"), ("IntervalSeconds", "10"));

        PluginConfigBinder.Bind(plugin, "example", sections);

        Assert.True(plugin.Settings.Enabled);
        Assert.Equal("/var/log/x.txt", plugin.Settings.Path);
        Assert.Equal(10, plugin.Settings.IntervalSeconds);
    }

    [Fact]
    public void AnUnreadableSection_LeavesThePluginOnDefaults_AndDoesNotThrow()
    {
        // A malformed block for one plugin must not stop the others loading, and must not stop the bridge:
        // Config.Plugins was typed as JsonNode once, which YamlDotNet cannot construct, and a config
        // carrying any Plugins section failed to parse at all.
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
        // No TypeScript ships with a plugin. The GUI's form is drawn from this, so a settings class has to
        // arrive as typed fields with their descriptions and defaults intact.
        var plugin = new ExamplePlugin();
        var schema = ConfigSchema.Build([(plugin.Id, plugin.DisplayName, plugin.ConfigType, plugin.Group.ToString())]);

        var section = schema.Single(n => n.Key == "example");
        Assert.True(section.IsPlugin);                     // so the form binds it under Config.Plugins
        Assert.Equal("Destinations", section.Group);       // so it lands in the right nav group
        Assert.Equal("bool", section.Properties!.Single(p => p.Key == "Enabled").Type);
        Assert.Equal("int", section.Properties!.Single(p => p.Key == "IntervalSeconds").Type);
        Assert.Equal("Where to write it.", section.Properties!.Single(p => p.Key == "Path").Description);
    }

    [Fact]
    public void CapabilitiesImplyTheirActions_AndDeclaredOnesAreAddedToThem()
    {
        var plugin = new ExamplePlugin();
        var actions = IntegrationActions.For(plugin);

        // probe comes from IIntegration itself — a plugin declares nothing to get it.
        Assert.Contains(actions, a => a.Name == IntegrationActions.Probe);
        Assert.Contains(actions, a => a.Name == "peek");
        // It publishes nothing, so it is not offered a publish or a sweep.
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

        // Off is not a problem, and must not be coloured like one.
        Assert.Equal(HealthLevel.Off, IntegrationHealthDefaults.For(plugin, cfg, status.For(plugin.Id)).Level);

        plugin.Settings.Enabled = true;
        // Enabled and yet to report is its own state — not healthy, not failing.
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
        Assert.NotNull(registry.Action("EXAMPLE", "PEEK"));   // ids and actions are matched case-insensitively
        Assert.Null(registry.Action("example", "nope"));
    }
}
