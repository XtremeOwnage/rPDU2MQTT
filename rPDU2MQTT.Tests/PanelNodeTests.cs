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
    public void AMappedBreakerIsANodeBeneathItsPanel_ValuedFromItsChannels()
    {
        var g = Build(Wiring(), new() { ["ch5|realpower"] = 240, ["ch1|realpower"] = 1100, ["ch2|realpower"] = 1150 });

        var lights = Node(g, "breaker:main_panel:B06")!;
        Assert.Equal("Kitchen lights", lights.Label);      // the directory's own words name the tier
        Assert.Equal("breaker", lights.Kind);
        Assert.Equal(240, lights.Value);
        // A double-pole breaker is one tier, worth both its legs.
        Assert.Equal(2250, Node(g, "breaker:main_panel:1,3")!.Value);
        // Beneath the panel, above the channels measuring it.
        Assert.Contains(g.Links, l => l.Source == "main" && l.Target == "breaker:main_panel:B06");
        Assert.Contains(g.Links, l => l.Source == "breaker:main_panel:1,3" && l.Target == "ch1");
        // An unused slot is not a tier.
        Assert.Null(Node(g, "breaker:main_panel:B09"));
    }

    [Fact]
    public void ThePanelDoesNotCountACircuitTwice_EvenWhereItWasWiredStraightToTheChannel()
    {
        var flow = Wiring();
        // How the schedule used to wire a mapped circuit: straight from the panel to the channel.
        flow.Links.Add(new EnergyFlowLink { From = "main", To = "ch5" });

        var g = Build(flow, new() { ["ch5|realpower"] = 240, ["ch1|realpower"] = 1100, ["ch2|realpower"] = 1150 });

        Assert.DoesNotContain(g.Links, l => l.Source == "main" && l.Target == "ch5");
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
    public void ABreakerOverItsRating_IsReported()
    {
        var live = new Fixed(new() { ["ch5|current"] = 24.5, ["ch5|realpower"] = 2800 });

        var f = Assert.Single(PanelAudit.Check(Wiring(), live, null), x => x.Kind == PanelAudit.OverRating);
        Assert.Equal("bad", f.Severity);
        Assert.Contains("24.5 A on a 20 A breaker", f.Message);
    }

    [Fact]
    public void AMappingThatHoldsTogether_ReportsNothing()
        => Assert.Empty(PanelAudit.Check(Wiring(), new Fixed(new() { ["ch5|realpower"] = 240, ["ch5|current"] = 2, ["ch1|realpower"] = 1100, ["ch2|realpower"] = 1150 }), ["ch5", "ch1", "ch2"]));
}
