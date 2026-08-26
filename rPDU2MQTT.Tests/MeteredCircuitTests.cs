using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Models.PDU;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// A metered circuit reports what its own clamp says.
///
/// <para>
/// Taken from a live sub-panel: 1,418 W at the panel's clamp, with two of its circuits metered at 1.8 W and
/// 1.2 W. Apportioning the panel's total across them by their share of demand drew the water heater at
/// 845 W — a figure nothing measured, 477x its own reading, and a ribbon that dwarfed the panel feeding it.
/// The 1,415 W nobody meters is the thing that was missing, and it now has a name.
/// </para>
/// </summary>
public class MeteredCircuitTests
{
    private sealed class Fixed(Dictionary<string, double> v) : IFlowValueSource
    {
        public bool TryGetValue(string node, string metric, out double value) => v.TryGetValue(node + "|" + metric, out value);
    }

    private static EnergyFlowConfig Panel(params (string Id, string Kind)[] nodes)
    {
        var c = new EnergyFlowConfig();
        foreach (var (id, k) in nodes) c.Nodes.Add(new EnergyFlowNode { Id = id, Kind = k });
        foreach (var (id, _) in nodes.Skip(1)) c.Links.Add(new EnergyFlowLink { From = nodes[0].Id, To = id });
        return c;
    }

    private static FlowGraph Build(EnergyFlowConfig cfg, Dictionary<string, double> live)
        => FlowGraphBuilder.Build(new PduData(), cfg, "realpower", new Fixed(live));

    private static readonly EnergyFlowConfig SubPanel =
        Panel(("sub_panel", "panel"), ("hot_water", "load"), ("server_ac", "load"));

    private static readonly Dictionary<string, double> Live = new()
    {
        ["sub_panel|realpower"] = 1418.28,
        ["hot_water|realpower"] = 1.77,
        ["server_ac|realpower"] = 1.20,
    };

    [Fact]
    public void AMeteredCircuitCarriesItsOwnReading_NotAShareOfThePanel()
    {
        var g = Build(SubPanel, Live);

        Assert.Equal(1.77, Assert.Single(g.Links, l => l.Target == "hot_water").Value, 2);
        Assert.Equal(1.20, Assert.Single(g.Links, l => l.Target == "server_ac").Value, 2);
    }

    [Fact]
    public void ThePanelsSurplusIsNamedAsUnmeasuredLoad()
    {
        var g = Build(SubPanel, Live);

        var gap = Assert.Single(g.Links, l => l.Target == "sub_panel#unmeasured");
        Assert.Equal(1418.28 - 1.77 - 1.20, gap.Value, 2);
        Assert.Contains(g.Nodes, n => n.Id == "sub_panel#unmeasured" && n.Kind == "unmeasured");
    }

    /// <summary>
    /// The bar height comes from throughput, so an inflated link is what made a 1.8 W water heater draw
    /// taller than the 1,392 W panel above it. This is the assertion that would have caught it.
    /// </summary>
    [Fact]
    public void NoLinkIntoAMeteredCircuitExceedsItsReading()
    {
        var g = Build(SubPanel, Live);

        foreach (var l in g.Links.Where(l => !l.Target.EndsWith("#unmeasured")))
        {
            var target = g.Nodes.Single(n => n.Id == l.Target);
            Assert.True(l.Value <= (target.Value ?? 0) + 0.01,
                $"{l.Source} -> {l.Target} carries {l.Value:0.##} into a node measuring {target.Value:0.##}");
        }
    }

    /// <summary>Only the children nothing measures divide up what the metered ones leave.</summary>
    [Fact]
    public void WhatTheMeteredCircuitsLeave_GoesToTheUnmeteredOnes()
    {
        var cfg = Panel(("panel", "panel"), ("metered", "load"), ("dark", "load"));
        var g = Build(cfg, new() { ["panel|realpower"] = 1000, ["metered|realpower"] = 250 });

        Assert.Equal(250, Assert.Single(g.Links, l => l.Target == "metered").Value, 2);
        // The unmetered circuit is the only place the other 750 W can have gone.
        Assert.Equal(750, Assert.Single(g.Links, l => l.Target == "dark").Value, 2);
        Assert.DoesNotContain(g.Nodes, n => n.Id == "panel#unmeasured");
    }

    /// <summary>
    /// A producer keeps conservation: its reading is what it PUT OUT, so all of it leaves down the links it
    /// has. A shortfall against a metered child there is a gap in the topology, not load on the producer.
    /// </summary>
    [Fact]
    public void AProducersOutputStillFlowsDownItsOnlyPath()
    {
        var cfg = Panel(("solar", "solar"), ("load", "load"));
        var g = Build(cfg, new() { ["solar|realpower"] = 750, ["load|realpower"] = 100 });

        Assert.Equal(750, Assert.Single(g.Links, l => l.Source == "solar").Value, 2);
    }

    /// <summary>
    /// A measured sub-panel reports its OWN inlet, so that is what reaches it — even though it has
    /// circuits of its own hanging off it.
    ///
    /// <para>
    /// Live, an inverter reading 6.97 kW was pushing 2.9 kW and 4.1 kW into two panels metering 1.04 kW and
    /// 1.47 kW, so each panel's bar was drawn at nearly three times its own reading and its circuits became
    /// a thin band at the top of a mostly empty bar. Having children of its own does not make a panel's
    /// clamp less of a measurement.
    /// </para>
    /// </summary>
    [Fact]
    public void AMeasuredSubPanelReportsItsOwnInlet_EvenWithCircuitsBelowIt()
    {
        var cfg = new EnergyFlowConfig();
        cfg.Nodes.Add(new EnergyFlowNode { Id = "panel", Kind = "panel" });
        cfg.Nodes.Add(new EnergyFlowNode { Id = "subpanel", Kind = "panel" });
        cfg.Nodes.Add(new EnergyFlowNode { Id = "circuit", Kind = "load" });
        cfg.Links.Add(new EnergyFlowLink { From = "panel", To = "subpanel" });
        cfg.Links.Add(new EnergyFlowLink { From = "subpanel", To = "circuit" });

        var g = Build(cfg, new() { ["panel|realpower"] = 900, ["subpanel|realpower"] = 400, ["circuit|realpower"] = 30 });

        Assert.Equal(400, Assert.Single(g.Links, l => l.Target == "subpanel").Value, 2);
        Assert.Equal(30, Assert.Single(g.Links, l => l.Target == "circuit").Value, 2);
        // Both surpluses are named rather than pushed onto whatever is metered below.
        Assert.Equal(500, Assert.Single(g.Links, l => l.Target == "panel#unmeasured").Value, 2);
        Assert.Equal(370, Assert.Single(g.Links, l => l.Target == "subpanel#unmeasured").Value, 2);
    }

    /// <summary>
    /// A producer down a single path keeps conservation: its reading is what it PUT OUT, and with one link
    /// to send it down, all of it goes there. This is the inverter bound to <c>load_power</c> while also
    /// charging a battery — its own figure covers one leg and cannot be what reaches the panel.
    /// </summary>
    [Fact]
    public void AProducerDownOnePathKeepsConservation()
    {
        var cfg = new EnergyFlowConfig();
        cfg.Nodes.Add(new EnergyFlowNode { Id = "solar", Kind = "solar" });
        cfg.Nodes.Add(new EnergyFlowNode { Id = "inverter", Kind = "inverter" });
        cfg.Nodes.Add(new EnergyFlowNode { Id = "panel", Kind = "panel" });
        cfg.Links.Add(new EnergyFlowLink { From = "solar", To = "inverter" });
        cfg.Links.Add(new EnergyFlowLink { From = "inverter", To = "panel" });

        var g = Build(cfg, new() { ["solar|realpower"] = 8344, ["inverter|realpower"] = 2526, ["panel|realpower"] = 2526 });

        Assert.Equal(8344, Assert.Single(g.Links, l => l.Target == "inverter").Value, 2);
        Assert.DoesNotContain(g.Nodes, n => n.Id == "solar#unmeasured");
    }

    /// <summary>What a producer cannot account for is not called load on the thing producing it.</summary>
    [Fact]
    public void AProducersSurplusIsNamedAsOutput_NotAsLoad()
    {
        var cfg = Panel(("inverter", "inverter"), ("main", "panel"), ("sub", "panel"));
        var g = Build(cfg, new() { ["inverter|realpower"] = 6970, ["main|realpower"] = 1040, ["sub|realpower"] = 1470 });

        Assert.Equal(1040, Assert.Single(g.Links, l => l.Target == "main").Value, 2);
        Assert.Equal(1470, Assert.Single(g.Links, l => l.Target == "sub").Value, 2);
        var spare = Assert.Single(g.Nodes, n => n.Id == "inverter#unmeasured");
        Assert.Equal(4460, spare.Value!.Value, 2);
        Assert.Equal("Unaccounted output", spare.Label);
    }
}
