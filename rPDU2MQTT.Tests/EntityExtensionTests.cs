using System.ComponentModel;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Integrations;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Services.Gui;
using rPDU2MQTT.Startup;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>Settings a plugin keeps on core entities it does not define.</summary>
public class EntityExtensionTests
{
    private sealed class Where
    {
        [Description("The room it is in.")]
        public string Location { get; set; } = "";

        [DefaultValue(1)]
        public int Weight { get; set; } = 1;
    }

    private sealed class ExamplePlugin : IIntegration, IEntityExtensionProvider
    {
        public string Id => "where";
        public string DisplayName => "Where";
        public IntegrationGroup Group => IntegrationGroup.Integrations;
        public bool Enabled(Config cfg) => true;
        public IReadOnlyDictionary<string, Type> EntityExtensions { get; } = new Dictionary<string, Type>
        {
            [EntityKind.Node] = typeof(Where),
            [EntityKind.Breaker] = typeof(Where),
        };
    }

    private static Config FromJson(string nodeExt) => ConfigSchema.FromJson(
        $$"""{ "EnergyFlow": { "Nodes": [ { "Id": "fridge", "Label": "Fridge", "Ext": {{nodeExt}} } ] } }""");

    [Fact]
    public void ANodeWithNothingStored_ReadsAsDefaults()
    {
        var where = EntityExtensions.Read<Where>(new EnergyFlowNode { Id = "fridge" }, "where");

        Assert.Equal("", where.Location);
        Assert.Equal(1, where.Weight);
    }

    [Fact]
    public void WhatIsWritten_ReadsBack()
    {
        var node = new EnergyFlowNode { Id = "fridge" };

        EntityExtensions.Write(node, "where", new Where { Location = "kitchen", Weight = 3 });
        var where = EntityExtensions.Read<Where>(node, "where");

        Assert.Equal("kitchen", where.Location);
        Assert.Equal(3, where.Weight);
    }

    [Fact]
    public void RemovingTheLastEntry_DropsTheBag()
    {
        var node = new EnergyFlowNode { Id = "fridge" };
        EntityExtensions.Write(node, "where", new Where { Location = "kitchen" });

        EntityExtensions.Write(node, "where", null);

        Assert.Null(node.Ext);
    }

    [Fact]
    public void SettingsFromTheGui_ReadBack()
    {
        var cfg = FromJson("""{ "where": { "Location": "kitchen", "Weight": "2" } }""");

        var where = EntityExtensions.Read<Where>(cfg.EnergyFlow.Nodes[0], "where");

        Assert.Equal("kitchen", where.Location);
        Assert.Equal(2, where.Weight);
    }

    [Fact]
    public void SettingsSurviveBeingSavedAsYaml()
    {
        var cfg = FromJson("""{ "where": { "Location": "kitchen" } }""");
        EntityExtensions.Write(cfg.EnergyFlow.Nodes[0], "other", new Where { Location = "garage", Weight = 5 });

        var reloaded = YamlConfigLoader.DeserializeString(ConfigSchema.ToYaml(cfg));
        var node = reloaded.EnergyFlow.Nodes.Single();

        Assert.Equal("kitchen", EntityExtensions.Read<Where>(node, "where").Location);
        Assert.Equal("garage", EntityExtensions.Read<Where>(node, "other").Location);
        Assert.Equal(5, EntityExtensions.Read<Where>(node, "other").Weight);
    }

    [Fact]
    public void PluginSectionsFromTheGui_SaveAsTheirContent()
    {
        var cfg = ConfigSchema.FromJson("""{ "Plugins": { "where": { "Location": "kitchen", "Weight": 2 } } }""");

        var yaml = ConfigSchema.ToYaml(cfg);

        Assert.DoesNotContain("ValueKind", yaml);
        var reloaded = YamlConfigLoader.DeserializeString(yaml);
        Assert.Equal("kitchen", PluginConfigBinder.ToJson(reloaded.Plugins["where"])!["Location"]!.GetValue<string>());
    }

    [Fact]
    public void ANodeWithoutSettings_WritesNoExtKey()
    {
        var cfg = ConfigSchema.FromJson("""{ "EnergyFlow": { "Nodes": [ { "Id": "fridge" } ] } }""");

        Assert.DoesNotContain("Ext", ConfigSchema.ToYaml(cfg));
        Assert.DoesNotContain("\"Ext\"", ConfigSchema.ToJson(cfg));
    }

    [Fact]
    public void UnreadableSettings_FallBackToDefaults_AndAreKept()
    {
        var cfg = FromJson("""{ "where": "not an object" }""");
        var warnings = new List<string>();
        var node = cfg.EnergyFlow.Nodes[0];

        var where = EntityExtensions.Read<Where>(node, "where", warnings.Add);

        Assert.Equal("", where.Location);
        Assert.Single(warnings);
        Assert.True(node.Ext!.ContainsKey("where"));
    }

    [Fact]
    public void ThePluginsFields_AreDescribedOnEachEntitysExtensionPoint()
    {
        var plugin = new ExamplePlugin();
        var schema = ConfigSchema.Build([], EntityExtensions.Of([plugin]));

        var node = ValueOf(schema, "EnergyFlow", "Nodes").Properties!.Single(p => p.Key == "Ext");
        Assert.Equal(EntityKind.Node, node.ExtensionOf);
        var section = Assert.Single(node.Extensions!);
        Assert.Equal("where", section.Key);
        Assert.Equal("Where", section.Label);
        Assert.Equal("The room it is in.", section.Properties!.Single(p => p.Key == "Location").Description);

        var breaker = ValueOf(ValueOf(schema, "EnergyFlow", "Panels").Properties!, "Breakers").Properties!.Single(p => p.Key == "Ext");
        Assert.Single(breaker.Extensions!);

        // A panel was not extended by this plugin.
        var panel = ValueOf(schema, "EnergyFlow", "Panels").Properties!.Single(p => p.Key == "Ext");
        Assert.Equal(EntityKind.Panel, panel.ExtensionOf);
        Assert.Null(panel.Extensions);
    }

    [Fact]
    public void TheCrd_KeepsTheExtensionPointFreeForm()
    {
        var yaml = rPDU2MQTT.Startup.ConfigSources.CrdGenerator.ToYaml();
        var at = yaml.IndexOf("Ext:", yaml.IndexOf("EmonCmsVirtualTag:", StringComparison.Ordinal), StringComparison.Ordinal);
        var block = yaml[at..yaml.IndexOf("description:", yaml.IndexOf("additionalProperties:", at, StringComparison.Ordinal), StringComparison.Ordinal)];

        Assert.Contains("x-kubernetes-preserve-unknown-fields: true", block);
        Assert.DoesNotContain("Location", block);
    }

    private static SchemaNode ValueOf(IEnumerable<SchemaNode> nodes, params string[] path)
    {
        var node = nodes.Single(n => n.Key == path[0]);
        foreach (var key in path.Skip(1)) node = node.Properties!.Single(n => n.Key == key);
        return node.ValueSchema ?? node;
    }
}
