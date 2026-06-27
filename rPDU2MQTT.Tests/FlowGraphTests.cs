using rPDU2MQTT.Core.Flow;
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
}
