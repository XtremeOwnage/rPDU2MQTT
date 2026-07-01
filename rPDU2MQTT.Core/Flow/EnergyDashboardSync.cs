using System.Text.Json.Serialization;

namespace rPDU2MQTT.Core.Flow;

/// <summary>
/// One Home Assistant Energy-Dashboard "individual device" entry (the <c>device_consumption</c> shape).
/// HA's schema rejects a null <c>included_in_stat</c>/<c>name</c> — the keys must be omitted, not null —
/// so both are dropped from the JSON when unset.
/// </summary>
public sealed record HaDeviceConsumption(
    string stat_consumption,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? included_in_stat,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? name);

/// <summary>
/// Maps an energy-flow hierarchy onto Home Assistant's Energy-Dashboard device list (#128): one entry per
/// tier that has an energy stat, with <c>included_in_stat</c> set to its nearest ancestor that also has a
/// stat. HA's upstream relationship is single-parent, so a multi-feeder tier follows its primary feeder.
/// Pure (no HA/IO) so it's unit-testable; the service feeds it a resolver from tier id → HA energy entity_id.
/// </summary>
public static class EnergyDashboardSync
{
    public static List<HaDeviceConsumption> BuildDeviceConsumption(FlowGraph graph, Func<string, string?> statFor)
    {
        var entries = new List<HaDeviceConsumption>();
        foreach (var node in graph.Nodes)
        {
            var stat = statFor(node.Id);
            if (string.IsNullOrEmpty(stat))
                continue;   // no energy sensor for this tier -> can't be an Energy-Dashboard device
            entries.Add(new HaDeviceConsumption(stat, NearestAncestorStat(graph, node.Id, statFor), node.Label));
        }
        return entries;
    }

    // Walk up the primary-feeder chain to the first ancestor that has an energy stat (skipping tiers that
    // don't), so the upstream link stays valid even when an intermediate tier has no energy sensor.
    private static string? NearestAncestorStat(FlowGraph graph, string id, Func<string, string?> statFor)
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { id };
        var current = id;
        while (true)
        {
            var parents = FlowExport.Parents(graph, current);
            if (parents.Length == 0)
                return null;
            var parent = parents[0];        // HA upstream is single-parent: follow the primary feeder
            if (!seen.Add(parent))
                return null;                // cycle guard
            var stat = statFor(parent);
            if (!string.IsNullOrEmpty(stat))
                return stat;
            current = parent;
        }
    }
}
