using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Models.PDU;
using Xunit;

/// <summary>
/// Adding up a kind must not count the same energy twice (#491): the inverter's PV total and the MPPTs it is
/// grouped from are the same solar, and a sub-panel is already part of the panel above it.
/// </summary>
public class CountOnceTests
{
    private sealed class Fixed(Dictionary<string, double> v) : IFlowValueSource
    {
        public bool TryGetValue(string node, string metric, out double value) => v.TryGetValue(node + "|" + metric, out value);
    }

    /// <summary>The shape a hybrid inverter gives: one PV total, the strings it is made of, and the group saying so.</summary>
    private static EnergyFlowConfig Solar() => new()
    {
        Nodes =
        {
            new() { Id = "inverter", Kind = "inverter" },
            new() { Id = "pv", Label = "Solar (PV)", Kind = "solar" },
            new() { Id = "mppt_1", Kind = "solar" },
            new() { Id = "mppt_2", Kind = "solar" },
        },
        Links =
        {
            new() { From = "pv", To = "inverter" },
            new() { From = "mppt_1", To = "inverter" },
            new() { From = "mppt_2", To = "inverter" },
        },
        Groups = { new EnergyFlowGroup { Id = "pv", Kind = "solar", Label = "Solar (PV)", Members = { "mppt_1", "mppt_2" } } },
    };

    [Fact]
    public void AGroupsMembersAreCountedByTheGroup_NotBesideIt()
    {
        var flow = Solar();
        var ids = new[] { "pv", "mppt_1", "mppt_2" };

        Assert.Equal("pv", CountOnce.CountedBy(flow, "mppt_1", ids));
        Assert.Equal("pv", CountOnce.CountedBy(flow, "mppt_2", ids));
        // The total itself is counted by nothing: it is what the others are inside.
        Assert.Null(CountOnce.CountedBy(flow, "pv", ids));
        Assert.Equal(["pv"], CountOnce.Summable(flow, ids));
    }

    [Fact]
    public void WithoutTheGroupsNodeInTheSet_AMemberIsCountedOnItsOwn()
    {
        // Charting the strings alone is a fair question; it is only adding them to their total that doubles.
        Assert.Null(CountOnce.CountedBy(Solar(), "mppt_1", new[] { "mppt_1", "mppt_2" }));
        Assert.Equal(["mppt_1", "mppt_2"], CountOnce.Summable(Solar(), new[] { "mppt_1", "mppt_2" }));
    }

    [Fact]
    public void AGroupInsideAGroup_IsCountedByTheOuterOne()
    {
        var flow = Solar();
        flow.Nodes.Add(new() { Id = "all_pv", Kind = "solar" });
        flow.Groups.Add(new EnergyFlowGroup { Id = "all_pv", Kind = "solar", Members = { "pv" } });

        Assert.Equal("all_pv", CountOnce.CountedBy(flow, "mppt_1", new[] { "all_pv", "mppt_1" }));
        Assert.Equal(["all_pv"], CountOnce.Summable(flow, new[] { "all_pv", "pv", "mppt_1", "mppt_2" }));
    }

    [Fact]
    public void ANodeBeneathAnother_IsAlreadyPartOfIt()
    {
        var flow = new EnergyFlowConfig
        {
            Nodes = { new() { Id = "main", Kind = "panel" }, new() { Id = "sub", Kind = "panel" }, new() { Id = "shed", Kind = "panel" } },
            Links = { new() { From = "main", To = "sub" }, new() { From = "sub", To = "shed" } },
        };
        var topology = FlowTopology.For(new PduData(), flow);
        var ids = new[] { "main", "sub", "shed" };

        Assert.Equal("main", CountOnce.CountedBy(flow, "sub", ids, topology));
        // Through the one between them: the shed is part of the main panel too.
        Assert.Equal("main", CountOnce.CountedBy(flow, "shed", ids, topology));
        Assert.Equal(["main"], CountOnce.Summable(flow, ids, topology));
        // Without the topology nothing but the groups is known, and these have none.
        Assert.Equal(ids, CountOnce.Summable(flow, ids));
    }

    [Fact]
    public void TheEnergyDashboardTakesThePvTotal_NotItAndItsStringsBoth()
    {
        var g = FlowGraphBuilder.Build(new PduData(), Solar(), FlowGraphBuilder.DefaultMetric,
            new Fixed(new() { ["pv|realpower"] = 4000, ["mppt_1|realpower"] = 2500, ["mppt_2|realpower"] = 1500 }));

        var sources = EnergyDashboardSync.BuildEnergySources(g, (id, dir) => dir == EnergyDirection.Out ? $"sensor.{id}_energy" : null);

        var solar = sources.Where(s => s["type"]?.ToString() == "solar").Select(s => s["stat_energy_from"]?.ToString()).ToList();
        Assert.Equal(["sensor.pv_energy"], solar);
    }

    [Fact]
    public void TheGraphSaysWhatAlreadyCountsEachNode()
    {
        var g = FlowGraphBuilder.Build(new PduData(), Solar(), FlowGraphBuilder.DefaultMetric,
            new Fixed(new() { ["pv|realpower"] = 4000, ["mppt_1|realpower"] = 2500, ["mppt_2|realpower"] = 1500 }));

        FlowNode Node(string id) => g.Nodes.First(n => n.Id == id);
        Assert.Equal("pv", Node("mppt_1").Within);
        Assert.Equal("pv", Node("mppt_2").Within);
        Assert.Null(Node("pv").Within);
        // Summing the solar kind off the graph is the PV total alone — 4 kW, not 8.
        var solar = g.Nodes.Where(n => n.Kind == "solar" && n.Within is null).Sum(n => n.Value ?? 0);
        Assert.Equal(4000, solar);
    }
}
