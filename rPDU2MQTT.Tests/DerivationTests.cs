using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Models.PDU;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// Provenance travels with the value. A figure conservation worked out is not wrong, but it is not a
/// measurement either, and a diagram that renders the two identically is stating something it cannot back up.
/// </summary>
public class DerivationTests
{
    private sealed class Fixed : IFlowValueSource
    {
        private readonly Dictionary<string, double> v;
        public Fixed(Dictionary<string, double> x) => v = x;
        public bool TryGetValue(string node, string metric, out double value) => v.TryGetValue(node + "|" + metric, out value);
    }

    private static PduData Pdu(double watts)
    {
        var o = new Outlet { Key = 0, Entity_Name = "o0", Entity_DisplayName = "Load" };
        o.Measurements.Add(new Measurement { Type = "realpower", Value = watts.ToString(), Units = "W" });
        var d = new Device { Key = "pdu1", Entity_Name = "pdu1", Entity_DisplayName = "PDU 1" };
        d.Outlets.Add(o);
        var data = new PduData();
        data.Devices.Add(d);
        return data;
    }

    /// <summary>
    /// feeder → panel → the metered PDU. Nothing measures the feeder.
    /// <paramref name="alternative"/> adds a second, inert feeder into the panel, which is what turns the
    /// back-fill from a roll-up (one possible route) into an attribution (a choice between routes) — the
    /// shape that credited a PV array with the whole house load after dark.
    /// </summary>
    private static EnergyFlowConfig Topology(bool infer = true, bool alternative = false)
    {
        var c = new EnergyFlowConfig { InferFromConservation = infer };
        c.Nodes.Add(new EnergyFlowNode { Id = "feeder", Kind = "grid" });
        c.Nodes.Add(new EnergyFlowNode { Id = "panel", Kind = "panel" });
        c.Links.Add(new EnergyFlowLink { From = "feeder", To = "panel" });
        c.Links.Add(new EnergyFlowLink { From = "panel", To = "pdu:pdu1" });
        if (alternative)
        {
            c.Nodes.Add(new EnergyFlowNode { Id = "solar", Kind = "solar", Mode = "none" });
            c.Links.Add(new EnergyFlowLink { From = "solar", To = "panel" });
        }
        return c;
    }

    private static FlowNode Node(FlowGraph g, string id) => g.Nodes.Single(n => n.Id == id);

    [Fact]
    public void AMeasuredNode_SaysSo()
    {
        var g = FlowGraphBuilder.Build(Pdu(700), Topology(), "realpower",
            new Fixed(new() { ["feeder|realpower"] = 700 }));

        Assert.Equal(FlowDerivation.Measured, Node(g, "feeder").Derivation);
        Assert.Equal(FlowDerivation.Measured, Node(g, "outlet:pdu1:0").Derivation);
    }

    [Fact]
    public void ARollUpOfMeasuredChildren_IsSummed_NotInferred()
    {
        // A PDU's total is real because its outlets are. Worth distinguishing from a back-fill.
        var g = FlowGraphBuilder.Build(Pdu(700), Topology(), "realpower",
            new Fixed(new() { ["feeder|realpower"] = 700 }));

        Assert.Equal(FlowDerivation.Summed, Node(g, "pdu:pdu1").Derivation);
    }

    [Fact]
    public void AnAttributionAmongAlternatives_IsLabelledInferred()
    {
        // Two feeders into the panel, one ruled out. The 700 W really was drawn, but saying it came through
        // *this* feeder is a claim about the hierarchy, not a reading — so it is labelled as one.
        var g = FlowGraphBuilder.Build(Pdu(700), Topology(alternative: true), "realpower", new Fixed(new()));

        var feeder = Node(g, "feeder");
        Assert.Equal(700, feeder.Value);
        Assert.Equal(FlowDerivation.Inferred, feeder.Derivation);
    }

    [Fact]
    public void ASoleRoute_IsARollUp_NotAnInference()
    {
        // One feeder is not a choice: the demand arrives by the only route there is. Labelling that inferred
        // would put the warning on most of the diagram and train people to ignore it.
        var g = FlowGraphBuilder.Build(Pdu(700), Topology(), "realpower", new Fixed(new()));

        Assert.Equal(700, Node(g, "feeder").Value);
        Assert.Equal(FlowDerivation.Summed, Node(g, "feeder").Derivation);
    }

    [Fact]
    public void WithInferenceOff_TheAttributionIsNotMade_AndNothingIsFabricatedTheOtherWay()
    {
        var g = FlowGraphBuilder.Build(Pdu(700), Topology(infer: false, alternative: true), "realpower", new Fixed(new()));

        var feeder = Node(g, "feeder");
        Assert.Null(feeder.Value);
        Assert.Equal(FlowDerivation.Unknown, feeder.Derivation);
        Assert.False(g.Links.Single(l => l.Source == "feeder" && l.Target == "panel").Known);
    }

    [Fact]
    public void WithInferenceOff_PlainRollUpsStillWork()
    {
        // The switch governs attribution, not arithmetic. Blanking out every PDU total would make it
        // unusable, and nobody would find out until their dashboards went empty.
        var g = FlowGraphBuilder.Build(Pdu(700), Topology(infer: false), "realpower", new Fixed(new()));

        Assert.Equal(700, Node(g, "pdu:pdu1").Value);
        Assert.Equal(700, Node(g, "feeder").Value);
    }

    [Fact]
    public void WithInferenceOff_MeasuredNodesAreUnaffected()
    {
        // The switch governs inference only. Anything actually metered keeps reporting.
        var g = FlowGraphBuilder.Build(Pdu(700), Topology(infer: false), "realpower",
            new Fixed(new() { ["feeder|realpower"] = 700 }));

        Assert.Equal(700, Node(g, "feeder").Value);
        Assert.Equal(FlowDerivation.Measured, Node(g, "feeder").Derivation);
        Assert.Equal(700, Node(g, "pdu:pdu1").Value);
    }

    [Fact]
    public void AnUnknownNode_IsNeverLabelledAsAnythingElse()
    {
        var c = Topology();
        c.Nodes.Add(new EnergyFlowNode { Id = "orphan", Kind = "node", Mode = "none" });
        c.Links.Add(new EnergyFlowLink { From = "orphan", To = "panel" });

        var g = FlowGraphBuilder.Build(Pdu(700), c, "realpower", new Fixed(new()));

        Assert.Equal(FlowDerivation.Unknown, Node(g, "orphan").Derivation);
        Assert.Null(Node(g, "orphan").Value);
    }
}
