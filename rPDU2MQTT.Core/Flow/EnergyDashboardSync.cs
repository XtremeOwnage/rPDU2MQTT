using System.Text.Json.Nodes;
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

/// <summary>The direction of a node's energy stat, relative to the node — see <see cref="Models.Config.EnergyFlowSource.Direction"/>.</summary>
public enum EnergyDirection
{
    /// <summary>Energy leaving the node toward the home: battery discharge, grid import, solar production.</summary>
    Out,
    /// <summary>Energy flowing back into the node from the home: battery charge, grid export.</summary>
    In,
}

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

    /// <summary>
    /// The kind-tagged flow nodes (<c>solar</c> / <c>battery</c> / <c>grid</c>) mapped onto Home Assistant's
    /// Energy-Dashboard <c>energy_sources</c> — the grid/solar/battery buckets, as opposed to the "individual
    /// devices" list <see cref="BuildDeviceConsumption"/> fills. This is the roll-up that makes HA's dashboard
    /// actually reflect the system, not just tally sub-loads (#energy-rollup).
    /// <para>
    /// <paramref name="statFor"/> resolves a node's energy stat in a direction: <c>Out</c> is the supply
    /// sensor (discharge/import/production) every tier already has; <c>In</c> is the return sensor
    /// (charge/export). It returns null when no such stat exists in HA — and a source is emitted only from the
    /// stats that actually resolve, so nothing here invents a statistic HA doesn't have. A battery needs both
    /// directions to be representable (HA requires <c>stat_energy_from</c> and <c>stat_energy_to</c>); a grid
    /// appears with whichever flow directions resolve.
    /// </para>
    /// </summary>
    public static List<JsonObject> BuildEnergySources(FlowGraph graph, Func<string, EnergyDirection, string?> statFor)
    {
        var sources = new List<JsonObject>();
        foreach (var node in graph.Nodes)
        {
            var outStat = statFor(node.Id, EnergyDirection.Out);
            var inStat = statFor(node.Id, EnergyDirection.In);
            switch (node.Kind?.ToLowerInvariant())
            {
                case "solar" when !string.IsNullOrEmpty(outStat):
                    sources.Add(new JsonObject { ["type"] = "solar", ["stat_energy_from"] = outStat });
                    break;

                // HA's battery source needs both a from (discharge) and a to (charge) stat; without the pair
                // it can't be expressed, so we skip it rather than emit a half-source HA will reject.
                case "battery" when !string.IsNullOrEmpty(outStat) && !string.IsNullOrEmpty(inStat):
                    sources.Add(new JsonObject { ["type"] = "battery", ["stat_energy_from"] = outStat, ["stat_energy_to"] = inStat });
                    break;

                case "grid" when !string.IsNullOrEmpty(outStat) || !string.IsNullOrEmpty(inStat):
                    var grid = new JsonObject { ["type"] = "grid", ["cost_adjustment_day"] = 0.0 };
                    if (!string.IsNullOrEmpty(outStat))
                        grid["flow_from"] = new JsonArray(new JsonObject { ["stat_energy_from"] = outStat });
                    if (!string.IsNullOrEmpty(inStat))
                        grid["flow_to"] = new JsonArray(new JsonObject { ["stat_energy_to"] = inStat });
                    sources.Add(grid);
                    break;
            }
        }
        return sources;
    }

    /// <summary>Every energy stat entity_id referenced by an <c>energy_sources</c> entry (ours or HA's) — used
    /// to tell our entries apart from the user's own when merging, without matching on <c>type</c>.</summary>
    public static IEnumerable<string> StatsOf(JsonObject source)
    {
        if ((string?)source["stat_energy_from"] is { Length: > 0 } from) yield return from;
        if ((string?)source["stat_energy_to"] is { Length: > 0 } to) yield return to;
        foreach (var key in new[] { "flow_from", "flow_to" })
            foreach (var flow in source[key]?.AsArray() ?? new JsonArray())
                if (flow is JsonObject f)
                {
                    if ((string?)f["stat_energy_from"] is { Length: > 0 } ff) yield return ff;
                    if ((string?)f["stat_energy_to"] is { Length: > 0 } ft) yield return ft;
                }
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
