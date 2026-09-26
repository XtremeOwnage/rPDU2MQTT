using rPDU2MQTT.Services.Gui;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// Settings that only apply to one choice of another setting. The form hides them the rest of the time, so
/// a rule that names the wrong sibling hides its setting permanently — with no error anywhere.
/// </summary>
public class VisibleWhenTests
{
    private static IEnumerable<(string Path, SchemaNode Node, List<SchemaNode> Siblings)> Walk(
        IEnumerable<SchemaNode> nodes, string path = "")
    {
        var list = nodes.ToList();
        foreach (var n in list)
        {
            yield return ($"{path}{n.Key}", n, list);
            if (n.Properties is { } props)
                foreach (var child in Walk(props, $"{path}{n.Key}."))
                    yield return child;
            if (n.ValueSchema?.Properties is { } vals)
                foreach (var child in Walk(vals, $"{path}{n.Key}[]."))
                    yield return child;
        }
    }

    [Fact]
    public void EveryRuleNamesASiblingThatExists()
    {
        foreach (var (path, node, siblings) in Walk(ConfigSchema.Build()))
        {
            if (node.VisibleWhen is not { } rule) continue;

            var decider = siblings.FirstOrDefault(s => s.Key == rule.Key);
            Assert.True(decider is not null, $"{path} is shown only when '{rule.Key}' matches, but no such setting sits beside it.");
            Assert.NotEmpty(rule.Values);
        }
    }

    [Fact]
    public void EveryRuleNamesValuesThatSettingCanHold()
    {
        // A value outside the deciding setting's choices can never match, which hides the setting for good.
        foreach (var (path, node, siblings) in Walk(ConfigSchema.Build()))
        {
            if (node.VisibleWhen is not { } rule) continue;
            var decider = siblings.First(s => s.Key == rule.Key);
            if (decider.EnumValues is not { } choices) continue;

            foreach (var v in rule.Values)
                Assert.True(choices.Contains(v), $"{path} is shown when {rule.Key} is '{v}', which is not one of its choices.");
        }
    }

    /// <summary>
    /// A source can be bound to every metric the bridge understands. The list used to be retyped on the
    /// setting, so a metric added to the table — temperature — was recorded by the history and offered
    /// by nothing.
    /// </summary>
    [Fact]
    public void ASourceCanBeBoundToEveryMetricTheBridgeUnderstands()
    {
        var flow = ConfigSchema.Build().Single(n => n.Key == "EnergyFlow");
        var metric = flow.Properties!.Single(p => p.Key == "Nodes")
            .ValueSchema!.Properties!.Single(p => p.Key == "Sources")
            .ValueSchema!.Properties!.Single(p => p.Key == "Metric");

        Assert.Equal("enum", metric.Type);
        foreach (var bindable in rPDU2MQTT.Core.Flow.FlowUnits.Bindable)
            Assert.Contains(bindable, metric.EnumValues!);
        // The ones a retyped list left out, temperature among them.
        foreach (var missed in new[] { "temperature", "percent" })
            Assert.Contains(missed, metric.EnumValues!);
        // …and still not the day's energy, which is derived from a counter's rise rather than published.
        Assert.DoesNotContain("energy_d", metric.EnumValues!);
    }

    [Fact]
    public void EachBackendsOwnSettingsAreShownForThatBackendAlone()
    {
        var history = ConfigSchema.Build().Single(n => n.Key == "History");
        var url = history.Properties!.Single(p => p.Key == "PrometheusUrl");

        Assert.Equal("Provider", url.VisibleWhen!.Key);
        Assert.Equal(["prometheus"], url.VisibleWhen.Values);

        // Where the bridge keeps its own readings, and for how long, is not a backend's setting: it records
        // whatever the pages read from, so hiding those behind the provider would hide a store that is still
        // being written to.
        var own = history.Properties!.Where(p => p.Key.StartsWith("Local", StringComparison.Ordinal)).ToList();
        Assert.NotEmpty(own);
        Assert.DoesNotContain(own, p => p.VisibleWhen is not null);

        // The rest of the page applies whichever backend is chosen, so nothing else is conditional.
        Assert.DoesNotContain(history.Properties!.Where(p => p.Key != "PrometheusUrl"), p => p.VisibleWhen is not null);
    }
}
