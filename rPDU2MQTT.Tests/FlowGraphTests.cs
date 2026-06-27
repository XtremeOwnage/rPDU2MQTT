using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Models.PDU;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>FlowGraphBuilder: auto-derive a PDU -> outlet power-flow graph from a snapshot (#97).</summary>
public class FlowGraphTests
{
    private static Outlet Outlet(int key, string name, string type, string value, string units = "W")
    {
        var o = new Outlet { Key = key, Entity_Name = $"o{key}", Entity_DisplayName = name };
        o.Measurements.Add(new Measurement { Type = type, Value = value, Units = units });
        return o;
    }

    private static PduData OnePdu(params Outlet[] outlets)
    {
        var device = new Device { Key = "pdu1", Entity_Name = "pdu1", Entity_DisplayName = "PDU 1" };
        device.Outlets.AddRange(outlets);
        var data = new PduData();
        data.Devices.Add(device);
        return data;
    }

    [Fact]
    public void Build_LinksOutletsToTheirPdu_WeightedByRealpower()
    {
        var graph = FlowGraphBuilder.Build(OnePdu(
            Outlet(0, "Outlet 1", "realpower", "100"),
            Outlet(1, "Outlet 2", "realpower", "50")));

        Assert.Equal("realpower", graph.Metric);
        Assert.Equal("W", graph.Units);
        Assert.Contains(graph.Nodes, n => n.Id == "pdu:pdu1" && n.Kind == "pdu");
        Assert.Equal(2, graph.Nodes.Count(n => n.Kind == "outlet"));
        Assert.Equal(100, graph.Links.Single(l => l.Target == "outlet:pdu1:0").Value);
        Assert.All(graph.Links, l => Assert.Equal("pdu:pdu1", l.Source));
    }

    [Fact]
    public void Build_SkipsZeroAndNonMatchingMeasurements()
    {
        var graph = FlowGraphBuilder.Build(OnePdu(
            Outlet(0, "Active", "realpower", "30"),
            Outlet(1, "Idle", "realpower", "0"),          // no flow -> skipped
            Outlet(2, "OtherMetric", "current", "2.5")));  // not the requested metric -> skipped

        Assert.Single(graph.Links);
        Assert.Equal("outlet:pdu1:0", graph.Links[0].Target);
        Assert.DoesNotContain(graph.Nodes, n => n.Id == "outlet:pdu1:1");
    }

    [Fact]
    public void Build_OmitsPdusWithNoMeasuredFlow()
    {
        var graph = FlowGraphBuilder.Build(OnePdu(Outlet(0, "Idle", "realpower", "0")));
        Assert.Empty(graph.Nodes);
        Assert.Empty(graph.Links);
    }

    [Fact]
    public void Build_MergesCustomHierarchy_AndPropagatesValuesUp()
    {
        var data = OnePdu(Outlet(0, "A", "realpower", "60"), Outlet(1, "B", "realpower", "40"));
        var flow = new EnergyFlowConfig
        {
            Nodes = { new EnergyFlowNode { Id = "total", Label = "Total" }, new EnergyFlowNode { Id = "breaker", Label = "Breaker 15" } },
            // outlets -> PDU (auto); PDU -> breaker -> total (custom). Energy flows parent -> child.
            Parents = { ["pdu:pdu1"] = "breaker", ["breaker"] = "total" },
        };

        var graph = FlowGraphBuilder.Build(data, flow);

        // The custom upstream links carry the aggregated downstream power (60 + 40 = 100).
        Assert.Equal(100, graph.Links.Single(l => l.Source == "total" && l.Target == "breaker").Value);
        Assert.Equal(100, graph.Links.Single(l => l.Source == "breaker" && l.Target == "pdu:pdu1").Value);
        Assert.Equal(60, graph.Links.Single(l => l.Target == "outlet:pdu1:0").Value);
        Assert.Contains(graph.Nodes, n => n.Id == "total" && n.Label == "Total");
    }

    [Fact]
    public void Build_UsesManualLeafValueForSensorlessNodes_AndAggregatesWithPduFlow()
    {
        // A panel fed by the PDU (60W of outlets) plus an untracked-but-known 40W load, under "Total".
        var data = OnePdu(Outlet(0, "Server", "realpower", "60"));
        var flow = new EnergyFlowConfig
        {
            Nodes =
            {
                new EnergyFlowNode { Id = "total", Label = "Panel" },
                new EnergyFlowNode { Id = "lights", Label = "Lights (known)", Value = 40 },
            },
            Parents = { ["pdu:pdu1"] = "total", ["lights"] = "total" },
        };

        var graph = FlowGraphBuilder.Build(data, flow);

        Assert.Equal(40, graph.Links.Single(l => l.Target == "lights").Value);   // manual leaf value
        Assert.Equal(100, graph.Links.Single(l => l.Target == "pdu:pdu1").Value + graph.Links.Single(l => l.Target == "lights").Value);
    }

    [Fact]
    public void Build_ExplicitParentOverridesAutoPduLink_OneFeederPerNode()
    {
        // Reparenting an outlet onto a custom breaker must suppress its auto PDU->outlet link,
        // so the outlet ends up with exactly one feeder (the bug: it had both).
        var data = OnePdu(Outlet(0, "Server", "realpower", "60"));
        var flow = new EnergyFlowConfig
        {
            Nodes = { new EnergyFlowNode { Id = "breaker", Label = "Breaker 15" } },
            Parents = { ["outlet:pdu1:0"] = "breaker" },
        };

        var graph = FlowGraphBuilder.Build(data, flow);

        Assert.DoesNotContain(graph.Links, l => l.Source == "pdu:pdu1" && l.Target == "outlet:pdu1:0");
        Assert.Equal(60, graph.Links.Single(l => l.Source == "breaker" && l.Target == "outlet:pdu1:0").Value);
        Assert.Single(graph.Links, l => l.Target == "outlet:pdu1:0");
    }

    [Fact]
    public void Build_IgnoresParentLinksToUnknownNodes()
    {
        var data = OnePdu(Outlet(0, "A", "realpower", "10"));
        var flow = new EnergyFlowConfig { Parents = { ["pdu:pdu1"] = "ghost" } }; // 'ghost' has no node def
        var graph = FlowGraphBuilder.Build(data, flow);

        Assert.DoesNotContain(graph.Nodes, n => n.Id == "ghost");
        Assert.DoesNotContain(graph.Links, l => l.Source == "ghost");
    }
}
