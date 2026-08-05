using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Models.PDU;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// The diagram must never state a number nobody supplied.
/// <para>
/// The bug these pin: three unmeasured sources (solar, battery, grid) feeding one inverter were each shown
/// carrying exactly a third of the house load — 184.333 W of 553 W — because the default <c>auto</c> mode
/// split a node's unmet demand equally between its unmeasured feeders. Nobody configured that split, and on
/// a diagram whose entire purpose is accurate power data it is indistinguishable from a real measurement.
/// </para>
/// </summary>
public class FlowNoFabricationTests
{
    private static Measurement M(string type, string value) => new() { Type = type, Value = value, Units = "W" };

    private static PduData Pdu(string name, params (string Outlet, string Watts)[] outlets)
    {
        var device = new Device { Key = name, Entity_Name = name, Entity_DisplayName = name };
        var i = 0;
        foreach (var (outlet, watts) in outlets)
            device.Outlets.Add(new Outlet
            {
                Key = i++,
                Entity_Name = outlet,
                Entity_DisplayName = outlet,
                Measurements = { M("realpower", watts) },
            });
        return new PduData { Devices = { device } };
    }

    /// <summary>The reported topology: PV / battery / grid → inverter → main panel → two rack PDUs.</summary>
    private static EnergyFlowConfig House() => new()
    {
        Nodes =
        {
            new EnergyFlowNode { Id = "solar", Label = "Solar (PV)", Kind = "solar" },
            new EnergyFlowNode { Id = "battery", Label = "Battery", Kind = "battery" },
            new EnergyFlowNode { Id = "grid", Label = "Grid", Kind = "grid" },
            new EnergyFlowNode { Id = "inverter", Label = "EG4 FlexBoss 21", Kind = "inverter" },
            new EnergyFlowNode { Id = "main", Label = "Main Panel", Kind = "panel" },
        },
        Links =
        {
            new EnergyFlowLink { From = "solar", To = "inverter" },
            new EnergyFlowLink { From = "battery", To = "inverter" },
            new EnergyFlowLink { From = "grid", To = "inverter" },
            new EnergyFlowLink { From = "inverter", To = "main" },
            new EnergyFlowLink { From = "main", To = "pdu:rack1" },
        },
    };

    [Fact]
    public void UnmeasuredSources_AreNotHandedAShareOfTheLoad()
    {
        var graph = FlowGraphBuilder.Build(Pdu("rack1", ("Server", "300"), ("NAS", "253")), House());

        // Not one of them may carry a figure: nothing says whether the load came from PV, the battery or
        // the grid. Previously each was given 553/3 = 184.333 W.
        foreach (var id in new[] { "solar", "battery", "grid" })
        {
            Assert.Null(graph.Nodes.Single(n => n.Id == id).Value);
            Assert.Equal(0, graph.Links.Where(l => l.Source == id).Sum(l => l.Value));
            Assert.All(graph.Links.Where(l => l.Source == id), l => Assert.False(l.Known));
        }

        Assert.DoesNotContain(graph.Links, l => Math.Abs(l.Value - 553d / 3) < 0.01);
    }

    [Fact]
    public void TheMeasuredPartOfTheChain_IsStillReported()
    {
        var graph = FlowGraphBuilder.Build(Pdu("rack1", ("Server", "300"), ("NAS", "253")), House());

        // Refusing to invent must not throw away what *is* known: the outlets are metered, so everything
        // their demand determines by conservation — a single path — still carries its real figure.
        Assert.Equal(553, graph.Nodes.Single(n => n.Id == "main").Value);
        Assert.Equal(553, graph.Nodes.Single(n => n.Id == "inverter").Value);
        Assert.Equal(553, graph.Links.Single(l => l.Source == "inverter" && l.Target == "main").Value);
        Assert.Equal(300, graph.Nodes.Single(n => n.Id == "outlet:rack1:0").Value);
    }

    [Fact]
    public void ConfiguredNodes_StayOnTheDiagram_EvenWithNoData()
    {
        var graph = FlowGraphBuilder.Build(Pdu("rack1", ("Server", "300")), House());

        // The other half of the complaint: a node set to 'none' vanished entirely, which reads as "my
        // config is broken" rather than "nothing measures this yet". A wired node is always present.
        foreach (var id in new[] { "solar", "battery", "grid", "inverter", "main" })
            Assert.Contains(graph.Nodes, n => n.Id == id);
    }

    [Fact]
    public void MarkingAFeederResidual_IsHowYouAskForTheRemainder()
    {
        var flow = House();
        flow.Nodes.Single(n => n.Id == "grid").Mode = "residual";

        var graph = FlowGraphBuilder.Build(Pdu("rack1", ("Server", "300"), ("NAS", "253")), flow);

        // Told explicitly where the unaccounted load comes from, the graph says so — and its siblings still
        // claim nothing, because the instruction named one absorber.
        Assert.Equal(553, graph.Nodes.Single(n => n.Id == "grid").Value);
        Assert.Null(graph.Nodes.Single(n => n.Id == "solar").Value);
        Assert.Null(graph.Nodes.Single(n => n.Id == "battery").Value);
    }

    [Fact]
    public void AMeasuredSource_SuppliesItsRealFigure_AndTheRestStayUnknown()
    {
        var flow = House();
        flow.Nodes.Single(n => n.Id == "solar").Value = 200;   // a bound/static reading

        var graph = FlowGraphBuilder.Build(Pdu("rack1", ("Server", "300"), ("NAS", "253")), flow);

        // Solar reports what it actually generates. The 353 W it doesn't cover is NOT then split between
        // battery and grid — that would be the same invention in a subtler place.
        Assert.Equal(200, graph.Nodes.Single(n => n.Id == "solar").Value);
        Assert.Null(graph.Nodes.Single(n => n.Id == "battery").Value);
        Assert.Null(graph.Nodes.Single(n => n.Id == "grid").Value);
    }

    [Fact]
    public void UnknownIsNotZero_ForAnythingThatPublishes()
    {
        var graph = FlowGraphBuilder.Build(Pdu("rack1", ("Server", "300")), House());

        // An exporter must be able to tell "no data" from a real 0 W, or it publishes a fabricated zero to
        // Home Assistant / Prometheus / EmonCMS and someone's history records it as fact.
        Assert.False(FlowExport.TryNodeValue(graph, "solar", out _));
        Assert.True(FlowExport.TryNodeValue(graph, "main", out var main));
        Assert.Equal(300, main);
    }

    [Fact]
    public void AnUnmeasuredNode_SumsItsFeeders_NotOnlyItsChildren()
    {
        // Raised on #292: "aggregate aggregates from CHILDREN, and not the parent" — an inverter fed by
        // measured sources appeared not to take their sum. It does: a node with no reading of its own is
        // worth the larger of what its known links bring in and what they carry out, so supply settles it
        // when nothing downstream is measured.
        //
        // The part that reads as the value being ignored is the other half: the supply that no measured
        // child accounts for becomes an explicit "Unmeasured load" leaf rather than being quietly dropped
        // (which would shrink the inverter) or spread over the children (which would invent figures).
        var flow = new EnergyFlowConfig
        {
            Nodes =
            {
                new EnergyFlowNode { Id = "solar", Label = "Solar", Kind = "solar", Mode = "static", Value = 5000 },
                new EnergyFlowNode { Id = "battery", Label = "Battery", Kind = "battery", Mode = "static", Value = 1000 },
                new EnergyFlowNode { Id = "grid", Label = "Grid", Kind = "grid", Mode = "static", Value = 2000 },
                new EnergyFlowNode { Id = "inverter", Label = "Inverter", Kind = "inverter" },
                new EnergyFlowNode { Id = "main", Label = "Main Panel", Kind = "panel" },
            },
            Links =
            {
                new EnergyFlowLink { From = "solar", To = "inverter" },
                new EnergyFlowLink { From = "battery", To = "inverter" },
                new EnergyFlowLink { From = "grid", To = "inverter" },
                new EnergyFlowLink { From = "inverter", To = "main" },
            },
        };

        var graph = FlowGraphBuilder.Build(new PduData(), flow);

        var inverter = graph.Nodes.Single(n => n.Id == "inverter");
        Assert.Equal(8000, inverter.Value);
        Assert.Equal(FlowDerivation.Summed, inverter.Derivation);

        // And it is accounted for, not absorbed: the whole 8 kW leaves as unmeasured load, because nothing
        // downstream measures anything.
        var slack = graph.Links.Single(l => l.Source == "inverter" && l.Target.EndsWith("#unmeasured"));
        Assert.Equal(8000, slack.Value);
    }

    [Fact]
    public void ASingleUnmeasuredFeeder_StillConveys_BecauseConservationLeavesNoChoice()
    {
        // One path in, a metered load downstream: the power demonstrably arrives that way. This is
        // inference from measurement, not invention, and it's what keeps ordinary chains working.
        var flow = new EnergyFlowConfig
        {
            Nodes = { new EnergyFlowNode { Id = "main", Label = "Main" } },
            Links = { new EnergyFlowLink { From = "main", To = "pdu:rack1" } },
        };

        var graph = FlowGraphBuilder.Build(Pdu("rack1", ("Server", "120")), flow);

        Assert.Equal(120, graph.Nodes.Single(n => n.Id == "main").Value);
        Assert.True(graph.Links.Single(l => l.Source == "main").Known);
    }
}
