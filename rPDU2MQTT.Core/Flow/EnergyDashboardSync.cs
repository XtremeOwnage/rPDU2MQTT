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
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? name,
    // stat_rate = an optional power sensor for real-time monitoring (HA's "Device power consumption").
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? stat_rate = null);

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
    /// <param name="include">
    /// Optional per-node gate — the caller's tag filter (#342). Applied here rather than by handing in a
    /// pruned graph, so parent lookups still see the whole hierarchy: a filtered-out feeder must not turn
    /// its children into orphans.
    /// </param>
    public static List<HaDeviceConsumption> BuildDeviceConsumption(FlowGraph graph, Func<string, string?> statFor,
        IReadOnlyCollection<string>? excludeKinds = null, Func<string, string?>? powerFor = null,
        Func<FlowNode, bool>? include = null)
    {
        var excluded = excludeKinds is { Count: > 0 }
            ? new HashSet<string>(excludeKinds, StringComparer.OrdinalIgnoreCase)
            : null;
        // Sources/storage/pass-through (grid, solar, battery, inverter) aren't "device consumption" — they
        // clutter the list and double-count against the dashboard's own grid/solar/battery buckets. Neither
        // are the tiers feeding them: an MPPT is generation, and listing it counts production as load (#382).
        var notDevices = NotDevices(graph, excluded);
        var entries = new List<HaDeviceConsumption>();
        // Diagram-only nodes are not devices — see FlowNode.Synthetic.
        foreach (var node in graph.Nodes.Where(n => !n.Synthetic))
        {
            if (include is not null && !include(node)) continue;
            if (notDevices.Contains(node.Id))
                continue;
            var stat = statFor(node.Id);
            if (string.IsNullOrEmpty(stat))
                continue;   // no energy sensor for this tier -> can't be an Energy-Dashboard device
            var power = powerFor?.Invoke(node.Id);   // optional real-time power sensor
            entries.Add(new HaDeviceConsumption(stat, NearestAncestorStat(graph, node.Id, statFor, notDevices), node.Label,
                string.IsNullOrEmpty(power) ? null : power));
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
    /// <param name="include">Optional per-node gate — the caller's tag filter (#342).</param>
    public static List<JsonObject> BuildEnergySources(FlowGraph graph, Func<string, EnergyDirection, string?> statFor,
        Func<string, string?>? powerFor = null, Func<string, string?>? socFor = null,
        Func<FlowNode, bool>? include = null)
    {
        var sources = new List<JsonObject>();
        // …and they are not energy sources either.
        foreach (var node in graph.Nodes.Where(n => !n.Synthetic))
        {
            if (include is not null && !include(node)) continue;
            var outStat = statFor(node.Id, EnergyDirection.Out);
            var inStat = statFor(node.Id, EnergyDirection.In);
            var power = powerFor?.Invoke(node.Id);   // signed power sensor (positive supplying); optional
            switch (node.Kind?.ToLowerInvariant())
            {
                case "solar" when !string.IsNullOrEmpty(outStat):
                    var solar = new JsonObject { ["type"] = "solar", ["stat_energy_from"] = outStat };
                    if (!string.IsNullOrEmpty(power)) solar["stat_rate"] = power;   // solar production power
                    sources.Add(solar);
                    break;

                // HA's battery source needs both a from (discharge) and a to (charge) stat; without the pair
                // it can't be expressed, so we skip it rather than emit a half-source HA will reject. Power goes
                // in power_config (Standard = one signed stat_rate); state of charge in stat_soc.
                case "battery" when !string.IsNullOrEmpty(outStat) && !string.IsNullOrEmpty(inStat):
                    var battery = new JsonObject { ["type"] = "battery", ["stat_energy_from"] = outStat, ["stat_energy_to"] = inStat };
                    if (!string.IsNullOrEmpty(power)) battery["power_config"] = new JsonObject { ["stat_rate"] = power };
                    if (socFor?.Invoke(node.Id) is { Length: > 0 } socStat) battery["stat_soc"] = socStat;
                    sources.Add(battery);
                    break;

                // HA's grid source is FLAT: stat_energy_from = import, stat_energy_to = export, right on the
                // object — NOT the flow_from/flow_to arrays older docs show (those are "extra keys" to the
                // current schema, which is what save_prefs rejected). cost_adjustment_day is required; a signed
                // power sensor goes in the top-level stat_rate.
                case "grid" when !string.IsNullOrEmpty(outStat) || !string.IsNullOrEmpty(inStat):
                    var grid = new JsonObject { ["type"] = "grid", ["cost_adjustment_day"] = 0.0 };
                    if (!string.IsNullOrEmpty(outStat)) grid["stat_energy_from"] = outStat;
                    if (!string.IsNullOrEmpty(inStat)) grid["stat_energy_to"] = inStat;
                    if (!string.IsNullOrEmpty(power)) grid["stat_rate"] = power;
                    sources.Add(grid);
                    break;
            }
        }
        return sources;
    }

    /// <summary>Every energy stat entity_id referenced by an <c>energy_sources</c> entry (ours or HA's) — used
    /// to tell our entries apart from the user's own when merging, without matching on <c>type</c>.</summary>
    /// <summary>The prefix every unique_id this bridge gives a flow tier's sensors carries.</summary>
    public const string OwnedUniqueIdPrefix = "energyflow_";

    /// <summary>
    /// Is this <c>energy_sources</c> entry one we put there?
    ///
    /// <para>
    /// Asking "does it reference a stat we are producing right now" is not the same question, and the gap
    /// between them orphans entries permanently. When an entity id changes — a node renamed, or Home
    /// Assistant registering a second entity and suffixing it <c>_2</c> — the entry we wrote last time
    /// stops matching anything we currently produce, so it reads as the user's own and is kept forever.
    /// The dashboard then carries a dead source beside the live one, and while both were alive it was
    /// counting the same generation twice.
    /// </para>
    /// <para>
    /// Ownership is a property of the entity, not of this pass: our sensors' unique_ids all begin with
    /// <see cref="OwnedUniqueIdPrefix"/>, and Home Assistant's registry maps an entity id back to one.
    /// A stat we cannot resolve at all is left alone — that is a stat about something else.
    /// </para>
    /// </summary>
    public static bool IsOurs(JsonObject source, IReadOnlyDictionary<string, string> uniqueByEntity,
                              IReadOnlySet<string> producedNow)
        => StatsOf(source).Any(stat =>
               producedNow.Contains(stat)
               || (uniqueByEntity.TryGetValue(stat, out var uid)
                   && uid.StartsWith(OwnedUniqueIdPrefix, StringComparison.OrdinalIgnoreCase)));

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

    // Walk up the primary-feeder chain to the first ancestor that has an energy stat AND is itself a device
    // (not an excluded source/storage tier), so a device's included_in_stat never points at a tier we left out
    // of the list — and the link still spans intermediate tiers that have no sensor.
    private static string? NearestAncestorStat(FlowGraph graph, string id, Func<string, string?> statFor, ISet<string> notDevices)
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
            if (!string.IsNullOrEmpty(stat) && !notDevices.Contains(parent))
                return stat;
            current = parent;
        }
    }

    /// <summary>
    /// The node ids that are not "individual devices": the excluded kinds themselves, plus the unclassified
    /// tiers that only ever flow into one — an MPPT or a PV string wired into the inverter is generation, and
    /// HA would otherwise chart that production as consumption (#382). A tier the user did classify (a panel,
    /// a load, a PDU) is taken at its word, so a panel feeding an inverter stays a device.
    /// </summary>
    private static HashSet<string> NotDevices(FlowGraph graph, ISet<string>? excluded)
    {
        var ids = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (excluded is null || excluded.Count == 0) return ids;

        var kindOf = graph.Nodes.ToDictionary(n => n.Id, n => n.Kind ?? "node", StringComparer.OrdinalIgnoreCase);
        bool IsExcludedKind(string id) => excluded.Contains(kindOf.TryGetValue(id, out var k) ? k : "node");
        string[] Targets(string id) => graph.Links
            .Where(l => string.Equals(l.Source, id, StringComparison.OrdinalIgnoreCase))
            .Select(l => l.Target).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();

        var walking = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        bool FeedsOnlyGeneration(string id)
        {
            // Only an unclassified tier is reclassified this way, and a leaf is a consumer, not a feeder.
            var kind = kindOf.TryGetValue(id, out var k) ? k : "node";
            if (!string.IsNullOrEmpty(kind) && !string.Equals(kind, "node", StringComparison.OrdinalIgnoreCase)) return false;
            var targets = Targets(id);
            if (targets.Length == 0 || !walking.Add(id)) return false;   // the guard also breaks a cycle
            var only = targets.All(t => IsExcludedKind(t) || FeedsOnlyGeneration(t));
            walking.Remove(id);
            return only;
        }

        foreach (var node in graph.Nodes)
            if (IsExcludedKind(node.Id) || FeedsOnlyGeneration(node.Id))
                ids.Add(node.Id);
        return ids;
    }
}
