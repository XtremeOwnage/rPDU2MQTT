using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Models.PDU;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>A mapped breaker as a tier of the energy flow (#458), and what the mapping contradicts (#457).</summary>
public class PanelNodeTests
{
    private sealed class Fixed(Dictionary<string, double> v) : IFlowValueSource
    {
        public bool TryGetValue(string node, string metric, out double value) => v.TryGetValue(node + "|" + metric, out value);
    }

    /// <summary>A panel on the grid, with a single-pole circuit, a double-pole range, and an unused slot.</summary>
    private static EnergyFlowConfig Wiring() => new()
    {
        Nodes =
        {
            new() { Id = "grid", Kind = "grid" },
            new() { Id = "main", Kind = "panel" },
            new() { Id = "ch5", Label = "N30 1-5", Kind = "breaker" },
            new() { Id = "ch1", Label = "N30 1-1", Kind = "breaker" },
            new() { Id = "ch2", Label = "N30 1-2", Kind = "breaker" },
        },
        Links = { new() { From = "grid", To = "main" } },
        Panels =
        {
            new PanelConfig
            {
                Id = "main_panel", Name = "Main Panel", Node = "main",
                Breakers =
                {
                    new BreakerConfig { Slot = 6, Number = "B06", Amps = 20, Description = "Kitchen lights", State = BreakerState.Identified },
                    new BreakerConfig { Slot = 1, Number = "1,3", Poles = 2, Amps = 60, Description = "Range", State = BreakerState.Identified },
                    new BreakerConfig { Slot = 9, Number = "B09", State = BreakerState.Unused },
                },
            },
        },
        Clamps =
        {
            new CtClampConfig { Panel = "main_panel", Breaker = "B06", Channel = "ch5" },
            new CtClampConfig { Panel = "main_panel", Breaker = "1,3", Leg = 1, Channel = "ch1" },
            new CtClampConfig { Panel = "main_panel", Breaker = "1,3", Leg = 2, Channel = "ch2" },
        },
    };

    private static FlowGraph Build(EnergyFlowConfig flow, Dictionary<string, double> readings)
        => FlowGraphBuilder.Build(new PduData(), flow, FlowGraphBuilder.DefaultMetric, new Fixed(readings));

    private static FlowNode? Node(FlowGraph g, string id) => g.Nodes.FirstOrDefault(n => n.Id == id);

    [Fact]
    public void ABreakerMeasuredByOneChannel_IsThatChannel_NotASecondNodeRepeatingIt()
    {
        var g = Build(Wiring(), new() { ["ch5|realpower"] = 240, ["ch1|realpower"] = 1100, ["ch2|realpower"] = 1150 });

        // The channel already is the circuit: a tier above it would carry the same 240 W under a second name.
        Assert.Null(Node(g, "breaker:main_panel:B06"));
        Assert.Equal(240, Node(g, "ch5")!.Value);
        var fed = Assert.Single(g.Links, l => l.Source == "main" && l.Target == "ch5");
        Assert.Equal(240, fed.Value);
        // An unused slot is not a tier either.
        Assert.Null(Node(g, "breaker:main_panel:B09"));
    }

    [Fact]
    public void ADoublePoleOnTwoChannels_IsATierOfItsOwn_AboveBothLegs()
    {
        var g = Build(Wiring(), new() { ["ch5|realpower"] = 240, ["ch1|realpower"] = 1100, ["ch2|realpower"] = 1150 });

        var range = Node(g, "breaker:main_panel:1,3")!;
        Assert.Equal("Range", range.Label);                // the directory's own words name the tier
        Assert.Equal("breaker", range.Kind);
        Assert.Equal(2250, range.Value);                   // one tier, worth both its legs
        Assert.Contains(g.Links, l => l.Source == "main" && l.Target == "breaker:main_panel:1,3");
        Assert.Contains(g.Links, l => l.Source == "breaker:main_panel:1,3" && l.Target == "ch1");
    }

    [Fact]
    public void AChannelNamedAfterItself_TakesTheNameOfTheBreakerMeasuringIt()
    {
        var flow = Wiring();
        flow.Nodes.Single(n => n.Id == "ch5").Label = "ch5";      // an input number, not a circuit
        flow.Nodes.Single(n => n.Id == "ch1").Label = "Range leg A";

        var g = Build(flow, new() { ["ch5|realpower"] = 240, ["ch1|realpower"] = 1100, ["ch2|realpower"] = 1150 });

        Assert.Equal("Kitchen lights", Node(g, "ch5")!.Label);
        // A name someone has given the channel is left alone.
        Assert.Equal("Range leg A", Node(g, "ch1")!.Label);
    }

    [Fact]
    public void ThePanelDoesNotCountACircuitTwice_EvenWhereItWasWiredStraightToTheChannel()
    {
        var flow = Wiring();
        // How the schedule used to wire a mapped circuit: straight from the panel to the channel.
        flow.Links.Add(new EnergyFlowLink { From = "main", To = "ch5" });
        flow.Links.Add(new EnergyFlowLink { From = "main", To = "ch1" });

        var g = Build(flow, new() { ["ch5|realpower"] = 240, ["ch1|realpower"] = 1100, ["ch2|realpower"] = 1150 });

        // The single-channel breaker is that channel, so the panel feeds it once — not twice over two names.
        Assert.Single(g.Links, l => l.Source == "main" && l.Target == "ch5");
        // A leg of a double-pole hangs under the breaker, so the link straight from the panel is dropped.
        Assert.DoesNotContain(g.Links, l => l.Source == "main" && l.Target == "ch1");
        Assert.Equal(2490, Node(g, "main")!.Value);
    }

    [Fact]
    public void ABreakerMissingALegsReading_IsUnknown_NotHalfOfItself()
    {
        var g = Build(Wiring(), new() { ["ch5|realpower"] = 240, ["ch1|realpower"] = 1100 });

        var range = Node(g, "breaker:main_panel:1,3")!;
        Assert.Null(range.Value);
        Assert.Equal(FlowDerivation.Unknown, range.Derivation);
    }

    [Fact]
    public void AnIdentifiedBreakerNobodyMeasures_HasNoValue_RatherThanZero()
    {
        var flow = Wiring();
        flow.Panels[0].Breakers.Add(new BreakerConfig { Slot = 8, Number = "B08", Description = "Bathroom", State = BreakerState.Identified });

        var g = Build(flow, new() { ["ch5|realpower"] = 240 });

        var bath = Node(g, "breaker:main_panel:B08")!;
        Assert.Equal("Bathroom", bath.Label);
        Assert.Null(bath.Value);
    }

    [Fact]
    public void ABreakerWhoseChannelIsNotANode_KeepsATierOfItsOwn_RatherThanVanishing()
    {
        var flow = Wiring();
        // A clamp pointing at something the config does not have: the breaker is still in the directory.
        flow.Clamps.Single(c => c.Channel == "ch5").Channel = "nothing_reads_this";

        var g = Build(flow, new() { ["ch5|realpower"] = 240 });

        var lights = Node(g, "breaker:main_panel:B06")!;
        Assert.Equal("Kitchen lights", lights.Label);
        Assert.Null(lights.Value);
    }

    [Fact]
    public void ABreakerThatNamesItsOwnNode_UsesIt_RatherThanInventingOne()
    {
        var flow = Wiring();
        flow.Panels[0].Breakers[0].Node = "ch5";

        var g = Build(flow, new() { ["ch5|realpower"] = 240 });

        Assert.Null(Node(g, "breaker:main_panel:B06"));
        Assert.Contains(g.Links, l => l.Source == "main" && l.Target == "ch5");
        Assert.Equal(240, Node(g, "ch5")!.Value);
    }

    [Fact]
    public void OneChannelOnTwoBreakers_IsReported()
    {
        var flow = Wiring();
        flow.Clamps.Add(new CtClampConfig { Panel = "main_panel", Breaker = "B09", Channel = "ch5" });

        var f = Assert.Single(PanelAudit.Check(flow, new Fixed(new()), null), x => x.Kind == PanelAudit.ChannelShared);
        Assert.Equal("bad", f.Severity);
        Assert.Contains("main_panel/B06", f.Breakers);
        Assert.Contains("main_panel/B09", f.Breakers);
    }

    [Fact]
    public void AnUnusedBreakerDrawingPower_AChannelNobodyMapped_AndHalfADoublePole_AreReported()
    {
        var flow = Wiring();
        flow.Clamps.Add(new CtClampConfig { Panel = "main_panel", Breaker = "B09", Channel = "ch9" });
        flow.Clamps.RemoveAll(c => c.Channel == "ch2");

        var found = PanelAudit.Check(flow, new Fixed(new() { ["ch9|realpower"] = 300, ["ch7|realpower"] = 800, ["ch5|realpower"] = 2 }), ["ch5", "ch7", "ch9"]);

        Assert.Contains(found, x => x.Kind == PanelAudit.UnusedLive && x.Channels.Contains("ch9"));
        Assert.Contains(found, x => x.Kind == PanelAudit.ChannelUnmapped && x.Channels.Contains("ch7"));
        Assert.Contains(found, x => x.Kind == PanelAudit.HalfClamped && x.Breakers.Contains("main_panel/1,3"));
        // A channel barely reading is noise, not a circuit nobody mapped.
        Assert.DoesNotContain(found, x => x.Kind == PanelAudit.ChannelUnmapped && x.Channels.Contains("ch5"));
    }

    [Fact]
    public void AClampPointedAtABreakersOwnTier_IsReported()
    {
        var flow = Wiring();
        // What picking a breaker tier in the channel list leaves behind: a breaker measured by itself.
        flow.Clamps.Single(c => c.Channel == "ch5").Channel = "breaker:main_panel:B06";

        var f = Assert.Single(PanelAudit.Check(flow, new Fixed(new()), null), x => x.Kind == PanelAudit.ChannelIsATier);
        Assert.Equal("bad", f.Severity);
        Assert.Contains("main_panel/B06", f.Breakers);
    }

    [Fact]
    public void ABreakerOverItsRating_IsReported()
    {
        var live = new Fixed(new() { ["ch5|current"] = 24.5, ["ch5|realpower"] = 2800 });

        var f = Assert.Single(PanelAudit.Check(Wiring(), live, null), x => x.Kind == PanelAudit.OverRating);
        Assert.Equal("bad", f.Severity);
        Assert.Contains("24.5 A on a 20 A breaker", f.Message);
    }

    [Fact]
    public void APanelFedFromTwoPlaces_IsReported()
    {
        var flow = Wiring();
        flow.Nodes.Add(new() { Id = "generator", Kind = "generator" });
        flow.Links.Add(new() { From = "generator", To = "main" });

        var f = Assert.Single(PanelAudit.Check(flow, new Fixed(new()), null), x => x.Kind == PanelAudit.PanelMultiFed);
        Assert.Equal("bad", f.Severity);
        Assert.Contains("fed by 2 nodes: grid, generator", f.Message);
        Assert.Contains("A panel is fed from one place", f.Message);
    }

    [Fact]
    public void ACircuitWiredFromSomewhereElseAsWell_IsReported()
    {
        var flow = Wiring();
        // The circuit is beneath its panel through the directory, and wired again from another node: on the
        // graph it hangs off both, and its power is counted under each.
        flow.Nodes.Add(new() { Id = "shed_feed", Kind = "breaker" });
        flow.Links.Add(new() { From = "shed_feed", To = "ch5" });

        var f = Assert.Single(PanelAudit.Check(flow, new Fixed(new()), null), x => x.Kind == PanelAudit.CircuitMultiFed);
        Assert.Equal("bad", f.Severity);
        Assert.Contains("main_panel/B06", f.Breakers);
        Assert.Contains("shed_feed", f.Channels);
    }

    [Fact]
    public void ACircuitFedByItsOwnPanel_IsNotReportedTwice()
    {
        var flow = Wiring();
        // The link the schedule wrote before the breaker was a tier: the same feed, said twice.
        flow.Links.Add(new() { From = "main", To = "ch5" });

        Assert.DoesNotContain(PanelAudit.Check(flow, new Fixed(new()), null), x => x.Kind == PanelAudit.CircuitMultiFed);
    }

    [Fact]
    public void AMappingThatHoldsTogether_ReportsNothing()
        => Assert.Empty(PanelAudit.Check(Wiring(), new Fixed(new() { ["ch5|realpower"] = 240, ["ch5|current"] = 2, ["ch1|realpower"] = 1100, ["ch2|realpower"] = 1150 }), ["ch5", "ch1", "ch2"]));
}
