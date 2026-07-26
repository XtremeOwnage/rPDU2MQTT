using System.Linq;
using rPDU2MQTT.Core.Flow;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// Mapping the kind-tagged flow nodes onto Home Assistant's Energy-Dashboard <c>energy_sources</c>
/// (grid/solar/battery), including the Out/In direction split and the "never emit a stat HA doesn't have"
/// rule (#energy-rollup).
/// </summary>
public class EnergyDashboardSourcesTests
{
    private static FlowGraph Graph(params FlowNode[] nodes) =>
        new(nodes, System.Array.Empty<FlowLink>(), "realpower", "W");

    // A resolver over a fixed (id, direction) -> entity_id table; anything absent is "no stat in HA".
    private static System.Func<string, EnergyDirection, string?> Stats(params (string id, EnergyDirection dir, string entity)[] rows) =>
        (id, dir) => rows.FirstOrDefault(r => r.id == id && r.dir == dir).entity;

    [Fact]
    public void Solar_MapsProductionToStatEnergyFrom()
    {
        var sources = EnergyDashboardSync.BuildEnergySources(
            Graph(new FlowNode("pv", "Solar", "solar")),
            Stats(("pv", EnergyDirection.Out, "sensor.solar_energy")));

        var s = Assert.Single(sources);
        Assert.Equal("solar", (string?)s["type"]);
        Assert.Equal("sensor.solar_energy", (string?)s["stat_energy_from"]);
    }

    [Fact]
    public void Battery_NeedsBothDirections_ElseSkipped()
    {
        var node = new FlowNode("batt", "Battery", "battery");

        // Both directions -> a battery source with from (discharge) + to (charge).
        var both = EnergyDashboardSync.BuildEnergySources(Graph(node),
            Stats(("batt", EnergyDirection.Out, "sensor.batt_discharge"),
                  ("batt", EnergyDirection.In, "sensor.batt_charge")));
        var b = Assert.Single(both);
        Assert.Equal("battery", (string?)b["type"]);
        Assert.Equal("sensor.batt_discharge", (string?)b["stat_energy_from"]);
        Assert.Equal("sensor.batt_charge", (string?)b["stat_energy_to"]);

        // Only discharge known -> HA can't express a one-sided battery, so nothing is emitted.
        Assert.Empty(EnergyDashboardSync.BuildEnergySources(Graph(node),
            Stats(("batt", EnergyDirection.Out, "sensor.batt_discharge"))));
    }

    [Fact]
    public void Grid_EmitsWhicheverFlowsResolve()
    {
        var node = new FlowNode("grid", "Grid", "grid");

        // Import only -> flow_from present, flow_to omitted (not null — HA rejects nulls).
        var importOnly = Assert.Single(EnergyDashboardSync.BuildEnergySources(Graph(node),
            Stats(("grid", EnergyDirection.Out, "sensor.grid_import"))));
        Assert.Equal("grid", (string?)importOnly["type"]);
        Assert.Equal("sensor.grid_import", (string?)importOnly["flow_from"]!.AsArray()[0]!["stat_energy_from"]);
        Assert.False(importOnly.ContainsKey("flow_to"));

        // Both -> flow_from (import) + flow_to (export).
        var both = Assert.Single(EnergyDashboardSync.BuildEnergySources(Graph(node),
            Stats(("grid", EnergyDirection.Out, "sensor.grid_import"),
                  ("grid", EnergyDirection.In, "sensor.grid_export"))));
        Assert.Equal("sensor.grid_import", (string?)both["flow_from"]!.AsArray()[0]!["stat_energy_from"]);
        Assert.Equal("sensor.grid_export", (string?)both["flow_to"]!.AsArray()[0]!["stat_energy_to"]);
    }

    [Fact]
    public void NonRoleAndUnresolvedNodes_ProduceNothing()
    {
        var sources = EnergyDashboardSync.BuildEnergySources(
            Graph(new FlowNode("pdu", "A PDU", "pdu"),                  // not a role kind
                  new FlowNode("pv", "Solar", "solar")),               // role, but no stat resolves
            Stats());   // empty table
        Assert.Empty(sources);
    }

    [Fact]
    public void StatsOf_ExtractsEveryReferencedEntity()
    {
        var grid = Assert.Single(EnergyDashboardSync.BuildEnergySources(
            Graph(new FlowNode("grid", "Grid", "grid")),
            Stats(("grid", EnergyDirection.Out, "sensor.import"),
                  ("grid", EnergyDirection.In, "sensor.export"))));

        Assert.Equal(new[] { "sensor.import", "sensor.export" },
            EnergyDashboardSync.StatsOf(grid).OrderBy(x => x).Reverse().ToArray());
    }
}
