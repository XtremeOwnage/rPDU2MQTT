using rPDU2MQTT.Services.Gui;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// The GUI gathers every capability's on/off switch onto one Features page, and removes it from that
/// capability's own settings page — so a switch that isn't marked here doesn't move, it <em>disappears</em>.
/// These tests are the guard on that: the marks are what the page is built from.
/// </summary>
public class FeatureToggleTests
{
    private static readonly List<SchemaNode> Schema = ConfigSchema.Build();

    private static SchemaNode Section(string key) =>
        Schema.SingleOrDefault(n => n.Key == key) ?? throw new Xunit.Sdk.XunitException($"no '{key}' config section");

    private static SchemaNode Field(string section, string field) =>
        Section(section).Properties?.SingleOrDefault(p => p.Key == field)
        ?? throw new Xunit.Sdk.XunitException($"no '{section}.{field}' setting");

    [Theory]
    [InlineData("Gui", "Enabled")]
    [InlineData("Api", "Enabled")]
    [InlineData("Health", "Enabled")]
    [InlineData("Cache", "Enabled")]
    [InlineData("Operator", "Enabled")]
    [InlineData("EmonCMS", "Enabled")]
    // The two that don't follow the naming — the reason this is declared on the model rather than inferred
    // from the property name. A name-based rule would have dropped both off the Features page silently.
    [InlineData("HomeAssistant", "DiscoveryEnabled")]
    [InlineData("Prometheus", "Exporter")]
    public void EachCapabilitysSwitch_IsMarked(string section, string field) =>
        Assert.True(Field(section, field).IsFeatureToggle, $"{section}.{field} is a capability switch but is not marked [FeatureToggle]");

    [Fact]
    public void ANewTopLevelEnabledFlag_CannotGoUnmarked()
    {
        // The failure this exists to prevent: someone adds Foo.Enabled, the Features page never learns about
        // it, and the config form has always hidden it — so the setting exists in YAML with no control at all.
        var missed = Schema
            .Where(n => n.Type == "object")
            .SelectMany(n => (n.Properties ?? []).Select(p => (Section: n.Key, Field: p)))
            .Where(x => x.Field.Type == "bool" && x.Field.Key == "Enabled" && !x.Field.IsFeatureToggle)
            .Select(x => $"{x.Section}.{x.Field.Key}")
            .ToList();

        Assert.True(missed.Count == 0,
            "these top-level on/off flags are not marked [FeatureToggle], so the GUI renders them nowhere: " + string.Join(", ", missed));
    }

    [Fact]
    public void ASettingInsideAFeature_IsNotItselfAFeature()
    {
        // Nested Enabled flags configure a feature; they don't switch one on. EmonCMS.Feeds.Enabled,
        // Prometheus.Pushgateway.Enabled and HomeAssistant.EnergyDashboard.Enabled all belong on their own
        // pages — hoisting them would list several indistinguishable "Enabled" cards on Features, and strip
        // the switch from the page where it makes sense. Only the top level of a section may be marked.
        var deep = new List<string>();
        foreach (var section in Schema.Where(n => n.Type == "object"))
            foreach (var child in (section.Properties ?? []).Where(p => p.Type == "object"))
                Walk(child, $"{section.Key}.{child.Key}", deep);

        Assert.True(deep.Count == 0, "these are settings of a feature, not features, but are marked [FeatureToggle]: " + string.Join(", ", deep));

        static void Walk(SchemaNode node, string path, List<string> found)
        {
            foreach (var p in node.Properties ?? [])
            {
                if (p.IsFeatureToggle) found.Add($"{path}.{p.Key}");
                if (p.Type == "object") Walk(p, $"{path}.{p.Key}", found);
            }
        }
    }

    [Fact]
    public void TheGuisOwnSwitch_IsAFeatureAndStillNotEditableHere()
    {
        // Both marks apply at once, and they don't interfere: the GUI appears on the Features page (hiding it
        // reads as unsupported) but stays locked, because turning it off from inside it locks you out.
        var gui = Field("Gui", "Enabled");
        Assert.True(gui.IsFeatureToggle);
        Assert.False(string.IsNullOrWhiteSpace(gui.NotEditableReason));
    }
}
