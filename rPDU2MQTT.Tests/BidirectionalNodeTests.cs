using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Models.PDU;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// A battery and a grid tie carry power both ways, but a Sankey is a DAG: a two-way edge cannot be laid
/// out and a signed value cannot be drawn. The supply direction stays on the node (left of the hub it
/// feeds) and the draw direction becomes a sink on the other side of that hub, so charging reads as the
/// inverter feeding the battery.
/// </summary>
public class BidirectionalNodeTests
{
    private sealed class Fixed : IFlowValueSource
    {
        private readonly Dictionary<string, double> v;
        public Fixed(Dictionary<string, double> x) => v = x;
        public bool TryGetValue(string node, string metric, out double value) => v.TryGetValue(node + "|" + metric, out value);
    }

    private static EnergyFlowConfig Topology()
    {
        var cfg = new EnergyFlowConfig();
        foreach (var (id, k, lbl) in new[]
                 {
                     ("battery", "battery", "Battery"), ("grid", "grid", "Grid"),
                     ("inverter", "inverter", "EG4 FlexBoss 21"), ("panel", "panel", "Main Panel"),
                 })
            cfg.Nodes.Add(new EnergyFlowNode { Id = id, Kind = k, Label = lbl });
        cfg.Links.Add(new EnergyFlowLink { From = "battery", To = "inverter" });
        cfg.Links.Add(new EnergyFlowLink { From = "grid", To = "inverter" });
        cfg.Links.Add(new EnergyFlowLink { From = "inverter", To = "panel" });
        return cfg;
    }

    private static FlowGraph Build(Dictionary<string, double> readings)
        => FlowGraphBuilder.Build(new PduData(), Topology(), "realpower", new Fixed(readings));

    [Fact]
    public void AChargingBatteryBecomesASinkOnTheFarSideOfTheHub()
    {
        var g = Build(new() { ["battery|realpower#in"] = 1500, ["inverter|realpower"] = 4000 });

        var lane = Assert.Single(g.Links, l => l.Target == "battery#in");
        Assert.Equal("inverter", lane.Source);        // the inverter is charging it
        Assert.Equal(1500, lane.Value);
        Assert.Contains(g.Nodes, n => n.Id == "battery#in" && n.Label == "Battery (charging)" && n.Kind == "battery");
    }

    [Fact]
    public void AnExportingGridIsLabelledAsExport()
    {
        var g = Build(new() { ["grid|realpower#in"] = 800, ["inverter|realpower"] = 4000 });

        Assert.Contains(g.Nodes, n => n.Id == "grid#in" && n.Label == "Grid (export)");
    }

    [Fact]
    public void BothDirectionsAtOnceDrawBothLanes()
    {
        // Discharging 562 W while 200 W is exported: two different nodes, two different flows.
        var g = Build(new()
        {
            ["battery|realpower"] = 562,
            ["grid|realpower#in"] = 200,
            ["inverter|realpower"] = 4000,
        });

        Assert.Contains(g.Links, l => l.Source == "battery" && l.Target == "inverter" && l.Value == 562);
        Assert.Contains(g.Links, l => l.Source == "inverter" && l.Target == "grid#in" && l.Value == 200);
    }

    [Fact]
    public void NoInDirectionReadingDrawsNoReturnLane()
    {
        var g = Build(new() { ["battery|realpower"] = 562, ["inverter|realpower"] = 4000 });

        Assert.DoesNotContain(g.Nodes, n => n.Id.EndsWith("#in"));
    }

    [Fact]
    public void AZeroDrawIsNotALane()
    {
        // Idle is not a flow: a 0 W charge would draw a hairline into a node that isn't doing anything.
        var g = Build(new() { ["battery|realpower#in"] = 0, ["inverter|realpower"] = 4000 });

        Assert.DoesNotContain(g.Nodes, n => n.Id.EndsWith("#in"));
    }

    [Fact]
    public void TheReturnLaneIsTerminalSoItCannotCloseACycle()
    {
        var g = Build(new() { ["battery|realpower#in"] = 1500, ["inverter|realpower"] = 4000 });

        Assert.DoesNotContain(g.Links, l => l.Source == "battery#in");
    }

    [Fact]
    public void AnyNodeCanBeBidirectional_NotJustBatteryAndGrid()
    {
        // Nothing here is special-cased to battery/grid: a panel that can back-feed gets a lane too, on the
        // same evidence — an in-direction reading. Only the wording follows the kind.
        var cfg = Topology();
        cfg.Nodes.Add(new EnergyFlowNode { Id = "sub_panel", Kind = "panel", Label = "Sub Panel" });
        cfg.Links.Add(new EnergyFlowLink { From = "sub_panel", To = "inverter" });

        var g = FlowGraphBuilder.Build(new PduData(), cfg, "realpower",
            new Fixed(new() { ["sub_panel|realpower#in"] = 400, ["inverter|realpower"] = 4000 }));

        Assert.Contains(g.Links, l => l.Source == "inverter" && l.Target == "sub_panel#in" && l.Value == 400);
        Assert.Contains(g.Nodes, n => n.Id == "sub_panel#in" && n.Label == "Sub Panel (in)");
    }
}
