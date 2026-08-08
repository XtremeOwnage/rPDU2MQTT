using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Models.Config;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// A node excluded from a destination by its tags stops being published there. Its retained Home Assistant
/// discovery config has to go with it: a config whose state topic no longer updates leaves the device in
/// Home Assistant reading unavailable.
/// </summary>
public class TagFilterDiscoveryTests
{
    private static FlowGraph Graph(params (string Id, string[] Tags)[] nodes) =>
        new([.. nodes.Select(n => new FlowNode(n.Id, n.Id, "node", 100, null, FlowDerivation.Measured, n.Tags))],
            [], "realpower", "W");

    /// <summary>The production rule, not a copy of it — the sweep and the exporter both call this.</summary>
    private static IReadOnlyList<string> CurrentDeviceIds(FlowGraph graph, NodeTagFilter filter) =>
        FlowExport.ExportedDeviceIds(graph, filter);

    [Fact]
    public void AnExcludedNodeIsNotCurrent_SoItsRetainedConfigIsSwept()
    {
        var graph = Graph(("keep", ["critical"]), ("drop", ["noisy"]));
        var filter = new NodeTagFilter { Exclude = { "noisy" } };

        var current = CurrentDeviceIds(graph, filter);
        Assert.Equal([FlowExport.DeviceId("keep")], current);

        string[] retained =
        [
            $"homeassistant/device/{FlowExport.DeviceId("keep")}/config",
            $"homeassistant/device/{FlowExport.DeviceId("drop")}/config",
        ];

        var orphans = FlowExport.OrphanedDiscoveryTopics(retained, current, "homeassistant");
        Assert.Equal([$"homeassistant/device/{FlowExport.DeviceId("drop")}/config"], orphans);
    }

    [Fact]
    public void WithNoFilterEveryNodeIsCurrent()
    {
        // The default. Adding the filter must not make the sweep start reporting live devices as orphans.
        var graph = Graph(("a", []), ("b", ["x"]));
        var current = CurrentDeviceIds(graph, new NodeTagFilter());

        Assert.Equal(2, current.Count);

        string[] retained = [.. current.Select(id => $"homeassistant/device/{id}/config")];
        Assert.Empty(FlowExport.OrphanedDiscoveryTopics(retained, current, "homeassistant"));
    }

    [Fact]
    public void AnIncludeListDropsUntaggedNodesFromCurrent()
    {
        var graph = Graph(("tagged", ["critical"]), ("untagged", []));
        var current = CurrentDeviceIds(graph, new NodeTagFilter { Include = { "critical" } });

        Assert.Equal([FlowExport.DeviceId("tagged")], current);
    }
}
