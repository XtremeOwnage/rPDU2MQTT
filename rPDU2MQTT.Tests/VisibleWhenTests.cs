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

    [Fact]
    public void ThePrometheusUrlBelongsToThePrometheusProvider()
    {
        var history = ConfigSchema.Build().Single(n => n.Key == "History");
        var url = history.Properties!.Single(p => p.Key == "PrometheusUrl");

        Assert.Equal("Provider", url.VisibleWhen!.Key);
        Assert.Equal(["prometheus"], url.VisibleWhen.Values);

        // The rest of the page applies to both backends, so nothing else is conditional.
        Assert.DoesNotContain(history.Properties!.Where(p => p.Key != "PrometheusUrl"), p => p.VisibleWhen is not null);
    }
}
