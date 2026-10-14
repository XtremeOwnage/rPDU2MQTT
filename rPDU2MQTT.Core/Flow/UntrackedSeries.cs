using rPDU2MQTT.Models.Config;

namespace rPDU2MQTT.Core.Flow;

/// <summary>
/// An untracked node's counter over a window, rebuilt from the counters it is the difference of.
///
/// <para>
/// What history holds for an untracked node is its parent's counter less its tracked siblings' counters, taken
/// at each sweep. That difference is not a counter: it falls whenever a sibling's counter climbs faster than
/// the parent's, and leaps whenever a sibling's counter resets. Read as a counter, every fall was booked as a
/// reset and the whole difference landed on one bar, so a panel whose every breaker is metered showed hundreds
/// of kWh a day it never used. Differencing each member on its own and subtracting the rises gives what the
/// parent used beyond its tracked children in each step, which is what the node means.
/// </para>
/// </summary>
public static class UntrackedSeries
{
    private static readonly StringComparer Ids = StringComparer.OrdinalIgnoreCase;

    /// <summary>One untracked node, the parent it is a slice of, and the siblings that account for the rest.</summary>
    public sealed record Plan(string Node, string Parent, IReadOnlyList<string> Tracked);

    /// <summary>
    /// Is <paramref name="metric"/> read as a counter and differenced by the reader? A lifetime total always is;
    /// a period total only when sampled within its days, since a per-day reading is already that day's total.
    /// </summary>
    public static bool Differenced(string metric, bool perDay)
        => FlowUnits.Epoch(metric) switch { "lifetime" => true, "period" => !perDay, _ => false };

    /// <summary>
    /// The untracked nodes that can be rebuilt: one feeder, and the only untracked child of it. Several untracked
    /// children of one parent share a spare that nothing apportions, so those are left as recorded.
    /// </summary>
    public static IReadOnlyList<Plan> For(EnergyFlowConfig flow, FlowTopology topology)
    {
        var mode = flow.Nodes.Where(n => !string.IsNullOrEmpty(n.Id))
            .GroupBy(n => n.Id, Ids)
            .ToDictionary(g => g.Key, g => (g.First().Mode ?? "").Trim(), Ids);
        bool Untracked(string id) => mode.TryGetValue(id, out var m) && string.Equals(m, "untracked", StringComparison.OrdinalIgnoreCase);

        var plans = new List<Plan>();
        foreach (var node in mode.Keys.Where(Untracked))
        {
            if (topology.Feeders(node) is not [var parent]) continue;
            var siblings = topology.Children(parent);
            if (siblings.Count(Untracked) != 1) continue;
            plans.Add(new Plan(node, parent, siblings.Where(c => !Untracked(c)).ToList()));
        }
        return plans;
    }

    /// <summary>The ids whose readings a rebuild needs besides the node itself.</summary>
    public static IEnumerable<string> Inputs(IEnumerable<Plan> plans)
        => plans.SelectMany(p => p.Tracked.Prepend(p.Parent)).Distinct(Ids);

    /// <summary>
    /// The rise of a counter at each step, read the way the Trends pages read one: a fall is a reset and the
    /// reading is what has accumulated since, unless the next reading is back up, which makes it noise. The first
    /// reading, and the first after a gap, has nothing to rise from.
    /// </summary>
    public static double?[] Rises(IReadOnlyList<double?> raw)
    {
        var rises = new double?[raw.Count];
        double? mark = null;
        for (var i = 0; i < raw.Count; i++)
        {
            if (raw[i] is not { } v) { mark = null; continue; }
            if (mark is not { } m) { mark = v; continue; }
            if (v >= m) { rises[i] = v - m; mark = v; continue; }
            if (i + 1 < raw.Count && raw[i + 1] is { } next && next >= m) { rises[i] = 0; continue; }
            rises[i] = v;
            mark = v;
        }
        return rises;
    }

    /// <summary>
    /// The node's counter rebuilt over the steps: zero at the first step its parent has a reading, then rising by
    /// whatever the parent rose beyond its tracked siblings. A step where the parent or a sibling that reports in
    /// the window has no rise is a gap. Null when the parent has nothing in the window.
    /// </summary>
    public static double?[]? Rebuild(Plan plan, IReadOnlyList<IReadOnlyDictionary<string, double>> perStep)
    {
        double?[] Raw(string id) => perStep.Select(s => s.TryGetValue(id, out var v) ? (double?)v : null).ToArray();
        var parentRaw = Raw(plan.Parent);
        if (parentRaw.All(v => v is null)) return null;

        var parent = Rises(parentRaw);
        // A sibling with nothing at all in the window is not part of the parent's draw here, as in the live graph.
        var tracked = plan.Tracked.Select(Raw).Where(r => r.Any(v => v is not null)).Select(Rises).ToList();

        var counter = new double?[perStep.Count];
        double? total = null;
        for (var i = 0; i < perStep.Count; i++)
        {
            if (total is null)
            {
                if (parentRaw[i] is not null) counter[i] = total = 0;
                continue;
            }
            if (parent[i] is not { } rise || tracked.Any(t => t[i] is null)) continue;
            total += Math.Max(0, rise - tracked.Sum(t => t[i]!.Value));
            counter[i] = total;
        }
        return counter;
    }

    /// <summary>Each step with the planned nodes' recorded readings replaced by their rebuilt counters.</summary>
    public static IReadOnlyList<IReadOnlyDictionary<string, double>> Apply(
        IEnumerable<Plan> plans, IReadOnlyList<IReadOnlyDictionary<string, double>> perStep)
    {
        var steps = perStep.Select(s => new Dictionary<string, double>(s, Ids)).ToList();
        foreach (var plan in plans)
        {
            if (Rebuild(plan, perStep) is not { } counter) continue;
            for (var i = 0; i < steps.Count; i++)
            {
                if (counter[i] is { } v) steps[i][plan.Node] = v;
                else steps[i].Remove(plan.Node);
            }
        }
        return steps;
    }
}
