using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Models.PDU;
using Xunit;

/// <summary>
/// Which nodes are the site's solar, grid, battery and home totals. What a node is (its kind) and what it
/// counts toward are separate: a hybrid inverter's reading is the house load, and the strings a PV total
/// is made of are solar without being added to it.
/// </summary>
public class EnergyBalanceTests
{
    private sealed class Fixed(Dictionary<string, double> v) : IFlowValueSource
    {
        public bool TryGetValue(string node, string metric, out double value) => v.TryGetValue(node + "|" + metric, out value);
    }

    /// <summary>A hybrid inverter as it is usually modelled: one node per reading it reports.</summary>
    private static EnergyFlowConfig Hybrid(EnergyBalanceConfig? balance = null) => new()
    {
        Nodes =
        {
            new() { Id = "inverter", Kind = "inverter" },
            new() { Id = "pv", Kind = "solar" },
            new() { Id = "mppt_1", Kind = "solar" },
            new() { Id = "mppt_2", Kind = "solar" },
            new() { Id = "battery", Kind = "battery" },
            new() { Id = "grid", Kind = "grid" },
            new() { Id = "panel", Kind = "panel" },
            new() { Id = "fridge", Kind = "load" },
        },
        Links =
        {
            new() { From = "pv", To = "inverter" },
            new() { From = "mppt_1", To = "inverter" },
            new() { From = "mppt_2", To = "inverter" },
            new() { From = "battery", To = "inverter" },
            new() { From = "grid", To = "inverter" },
            new() { From = "inverter", To = "panel" },
            new() { From = "panel", To = "fridge" },
        },
        Groups = { new() { Id = "pv", Kind = "solar", Members = { "mppt_1", "mppt_2" } } },
        Balance = balance ?? new(),
    };

    private static FlowGraph Build(EnergyFlowConfig flow) => FlowGraphBuilder.Build(new PduData(), flow, FlowGraphBuilder.DefaultMetric,
        new Fixed(new()
        {
            ["inverter|realpower"] = 3000, ["pv|realpower"] = 4000, ["mppt_1|realpower"] = 2500, ["mppt_2|realpower"] = 1500,
            ["battery|realpower"] = 200, ["grid|realpower"] = 100, ["fridge|realpower"] = 150,
        }));

    private static Dictionary<string, double> Totals(FlowGraph g) => g.Nodes
        .Where(n => n.Balance is not null && !n.Synthetic)
        .GroupBy(n => n.Balance!)
        .ToDictionary(x => x.Key, x => x.Sum(n => n.Value ?? 0));

    [Fact]
    public void TheBalanceNamesTheTotals_AndNothingElseCounts()
    {
        var g = Build(Hybrid(new() { Solar = { "pv" }, Grid = { "grid" }, Battery = { "battery" }, Home = { "inverter" } }));

        var totals = Totals(g);
        Assert.Equal(4000, totals["solar"]);     // the PV total, not it and its strings
        Assert.Equal(3000, totals["home"]);      // the inverter's load output, not the fridge
        Assert.Equal(200, totals["battery"]);
        Assert.Equal(100, totals["grid"]);
        Assert.Null(g.Nodes.First(n => n.Id == "fridge").Balance);
        Assert.Null(g.Nodes.First(n => n.Id == "mppt_1").Balance);
    }

    [Fact]
    public void SeveralNodesInOneTotalAreSummed()
    {
        // Two inverters' arrays, say: each listed, both counted.
        var g = Build(Hybrid(new() { Solar = { "mppt_1", "mppt_2" } }));
        Assert.Equal(4000, Totals(g)["solar"]);
        Assert.Null(g.Nodes.First(n => n.Id == "pv").Balance);
    }

    [Fact]
    public void WithoutABalance_ANodeCountsByItsKind_Once()
    {
        var g = Build(Hybrid());

        var totals = Totals(g);
        Assert.Equal(4000, totals["solar"]);      // the strings are held by the PV group
        Assert.Equal(200, totals["battery"]);
        Assert.Equal(100, totals["grid"]);
        // A load beneath a panel is already part of what the panel carries, so none is counted twice either.
        Assert.False(totals.ContainsKey("home"));
    }

    [Fact]
    public void AReturnLaneCountsTowardItsNodesTotal()
    {
        var flow = Hybrid(new() { Battery = { "battery" } });
        Assert.Equal("battery", EnergyBalance.RoleOf(flow, "battery#in", "battery", null));
        Assert.Null(EnergyBalance.RoleOf(flow, "battery#unmeasured", "battery", null));
        // Ids are matched as the rest of the flow matches them.
        Assert.Equal("battery", EnergyBalance.RoleOf(flow, "Battery", "node", null));
    }

    [Fact]
    public void TheEnergyDashboardTakesItsSourcesFromTheBalance()
    {
        // An inverter's own grid reading, and a utility meter: only the one named is the grid.
        var flow = Hybrid(new() { Solar = { "pv" }, Grid = { "meter" }, Battery = { "battery" }, Home = { "inverter" } });
        flow.Nodes.Add(new() { Id = "meter", Kind = "node" });
        flow.Links.Add(new() { From = "meter", To = "grid" });
        var g = Build(flow);

        var sources = EnergyDashboardSync.BuildEnergySources(g, (id, dir) => $"sensor.{id}_{dir}".ToLowerInvariant());

        Assert.Equal(["battery:sensor.battery_out", "grid:sensor.meter_out", "solar:sensor.pv_out"],
            sources.Select(s => $"{s["type"]}:{s["stat_energy_from"]}").Order().ToArray());
    }
}
