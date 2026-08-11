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

        // HA's grid source is flat: import = stat_energy_from, export = stat_energy_to (no flow_from/flow_to).
        // Import only -> stat_energy_from set, stat_energy_to absent.
        var importOnly = Assert.Single(EnergyDashboardSync.BuildEnergySources(Graph(node),
            Stats(("grid", EnergyDirection.Out, "sensor.grid_import"))));
        Assert.Equal("grid", (string?)importOnly["type"]);
        Assert.Equal("sensor.grid_import", (string?)importOnly["stat_energy_from"]);
        Assert.False(importOnly.ContainsKey("stat_energy_to"));
        Assert.False(importOnly.ContainsKey("flow_from"));

        // Both -> stat_energy_from (import) + stat_energy_to (export).
        var both = Assert.Single(EnergyDashboardSync.BuildEnergySources(Graph(node),
            Stats(("grid", EnergyDirection.Out, "sensor.grid_import"),
                  ("grid", EnergyDirection.In, "sensor.grid_export"))));
        Assert.Equal("sensor.grid_import", (string?)both["stat_energy_from"]);
        Assert.Equal("sensor.grid_export", (string?)both["stat_energy_to"]);
    }

    [Fact]
    public void Grid_And_Battery_CarryPowerAndSoc_WhenResolved()
    {
        var graph = Graph(new FlowNode("grid", "Grid", "grid"), new FlowNode("batt", "Battery", "battery"), new FlowNode("pv", "Solar", "solar"));
        var stats = Stats(("grid", EnergyDirection.Out, "sensor.grid_import"), ("grid", EnergyDirection.In, "sensor.grid_export"),
                          ("batt", EnergyDirection.Out, "sensor.batt_dis"), ("batt", EnergyDirection.In, "sensor.batt_chg"),
                          ("pv", EnergyDirection.Out, "sensor.pv_energy"));
        string? power(string id) => id == "grid" ? "sensor.grid_power" : id == "batt" ? "sensor.batt_power" : id == "pv" ? "sensor.pv_power" : null;
        string? soc(string id) => id == "batt" ? "sensor.batt_soc" : null;

        var sources = EnergyDashboardSync.BuildEnergySources(graph, stats, power, soc);
        var grid = Assert.Single(sources, s => (string?)s["type"] == "grid");
        var batt = Assert.Single(sources, s => (string?)s["type"] == "battery");
        var pv = Assert.Single(sources, s => (string?)s["type"] == "solar");

        // Grid/solar power is a top-level stat_rate; battery power is nested under power_config; SoC is stat_soc.
        Assert.Equal("sensor.grid_power", (string?)grid["stat_rate"]);
        Assert.Equal("sensor.pv_power", (string?)pv["stat_rate"]);
        Assert.Equal("sensor.batt_power", (string?)batt["power_config"]!["stat_rate"]);
        Assert.Equal("sensor.batt_soc", (string?)batt["stat_soc"]);
        // Absent resolvers -> keys omitted, not null (HA rejects nulls / unknown keys).
        var noExtras = EnergyDashboardSync.BuildEnergySources(graph, stats);
        var gridBare = Assert.Single(noExtras, s => (string?)s["type"] == "grid");
        Assert.False(gridBare.ContainsKey("stat_rate"));
        Assert.False(Assert.Single(noExtras, s => (string?)s["type"] == "battery").ContainsKey("power_config"));
    }

    [Fact]
    public void DeviceConsumption_CarriesPower_WhenResolved()
    {
        var graph = Graph(new FlowNode("rack", "Rack PDU", "pdu"));
        var devices = EnergyDashboardSync.BuildDeviceConsumption(graph, _ => "sensor.rack_energy",
            excludeKinds: null, powerFor: _ => "sensor.rack_power");
        Assert.Equal("sensor.rack_power", Assert.Single(devices).stat_rate);
        // No power resolver -> stat_rate null (omitted from JSON).
        Assert.Null(Assert.Single(EnergyDashboardSync.BuildDeviceConsumption(graph, _ => "sensor.rack_energy")).stat_rate);
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
    public void DeviceConsumption_ExcludesSourceAndStorageKinds()
    {
        // grid/solar/battery/inverter belong in the dashboard's own buckets, not the individual-devices list.
        var graph = Graph(
            new FlowNode("grid", "Grid", "grid"),
            new FlowNode("batt", "Battery", "battery"),
            new FlowNode("inv", "Inverter", "inverter"),
            new FlowNode("rack", "Rack PDU", "pdu"),
            new FlowNode("srv", "Server", "outlet"));
        string? stat(string id) => "sensor." + id + "_energy";   // everything has an energy stat

        var all = EnergyDashboardSync.BuildDeviceConsumption(graph, stat);
        Assert.Equal(5, all.Count);   // no exclusion -> every tier

        var filtered = EnergyDashboardSync.BuildDeviceConsumption(graph, stat, new[] { "grid", "solar", "battery", "inverter" });
        Assert.Equal(new[] { "sensor.rack_energy", "sensor.srv_energy" },
            filtered.Select(d => d.stat_consumption).OrderBy(x => x).ToArray());
    }

    [Fact]
    public void DeviceConsumption_IncludedInStat_SkipsAnExcludedAncestor()
    {
        // A server behind an excluded inverter should link upstream to the next *kept* ancestor, not the
        // inverter (which is no longer a device) — else included_in_stat dangles.
        var graph = new FlowGraph(
            new[] { new FlowNode("panel", "Panel", "panel"), new FlowNode("inv", "Inverter", "inverter"), new FlowNode("srv", "Server", "outlet") },
            new[] { new FlowLink("panel", "inv", 100), new FlowLink("inv", "srv", 100) },
            "realpower", "W");
        string? stat(string id) => "sensor." + id + "_energy";

        var srv = Assert.Single(EnergyDashboardSync.BuildDeviceConsumption(graph, stat, new[] { "inverter" }),
            d => d.stat_consumption == "sensor.srv_energy");
        Assert.Equal("sensor.panel_energy", srv.included_in_stat);   // skipped the inverter, linked to the panel
    }

    [Fact]
    public void DeviceConsumption_ExcludesTheTiersThatOnlyFeedGeneration()
    {
        // The MPPTs feed the inverter through a PV string; none of that is something the home consumes (#382).
        // The sub-panel behind the inverter, and the unclassified circuit under it, still are.
        var graph = new FlowGraph(
            new[]
            {
                new FlowNode("mppt1", "MPPT 1", "node"), new FlowNode("mppt2", "MPPT 2", "node"),
                new FlowNode("string", "PV String", "node"), new FlowNode("inv", "Inverter", "inverter"),
                new FlowNode("sub", "Sub Panel", "panel"), new FlowNode("circuit", "Kitchen", "node"),
            },
            new[]
            {
                new FlowLink("mppt1", "string", 100), new FlowLink("mppt2", "string", 100),
                new FlowLink("string", "inv", 200), new FlowLink("inv", "sub", 200),
                new FlowLink("sub", "circuit", 200),
            },
            "realpower", "W");
        string? stat(string id) => "sensor." + id + "_energy";

        var devices = EnergyDashboardSync.BuildDeviceConsumption(graph, stat, new[] { "grid", "solar", "battery", "inverter" });
        Assert.Equal(new[] { "sensor.circuit_energy", "sensor.sub_energy" },
            devices.Select(d => d.stat_consumption).OrderBy(x => x).ToArray());
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
