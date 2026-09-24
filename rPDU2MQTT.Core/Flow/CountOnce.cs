using rPDU2MQTT.Models.Config;

namespace rPDU2MQTT.Core.Flow;

/// <summary>
/// Which nodes may be added together, and which are already counted by another one.
/// <para>
/// Summing every node of a kind counts the same energy twice wherever one node already holds another: a solar
/// node with the MPPTs it is made of as a group, a sub-panel beneath its panel. A node that is inside another
/// is not added to it — it is reported as counted by it, so a caller can say so rather than silently drop it.
/// </para>
/// </summary>
public static class CountOnce
{
    private static readonly StringComparer Ids = StringComparer.OrdinalIgnoreCase;

    /// <summary>
    /// The node among <paramref name="among"/> that already counts <paramref name="id"/>, or null when none does.
    /// A group counts its members, however deeply they are nested, and a node counts everything beneath it.
    /// </summary>
    public static string? CountedBy(EnergyFlowConfig? flow, string id, IEnumerable<string> among, FlowTopology? topology = null)
    {
        if (string.IsNullOrWhiteSpace(id)) return null;
        var others = new HashSet<string>(among.Where(x => !string.IsNullOrWhiteSpace(x)), Ids);
        others.Remove(id);
        if (others.Count == 0) return null;

        // A group holds its members: the group's own node is the total, so a member added to it is that
        // member counted twice.
        foreach (var holder in Holders(flow, id))
            if (others.Contains(holder)) return holder;

        // Anything beneath another node is already part of it — except a node this one holds. A group is
        // wired beneath its own members, so by the links alone the total looks like part of every string.
        if (topology is not null)
            foreach (var other in others)
                if (topology.Beneath(id, other) && !Holders(flow, other).Contains(id, Ids)) return other;

        return null;
    }

    /// <summary>The nodes that may be summed: every one that nothing else here already counts.</summary>
    public static IReadOnlyList<string> Summable(EnergyFlowConfig? flow, IEnumerable<string> ids, FlowTopology? topology = null)
    {
        var all = ids.Where(x => !string.IsNullOrWhiteSpace(x)).Distinct(Ids).ToList();
        return [.. all.Where(id => CountedBy(flow, id, all, topology) is null)];
    }

    /// <summary>Every group that holds this node, directly or through another group.</summary>
    private static IEnumerable<string> Holders(EnergyFlowConfig? flow, string id)
    {
        var groups = flow?.Groups ?? [];
        var seen = new HashSet<string>(Ids);
        var queue = new Queue<string>();
        queue.Enqueue(id);
        while (queue.Count > 0)
        {
            var current = queue.Dequeue();
            foreach (var g in groups)
            {
                if (string.IsNullOrWhiteSpace(g.Id) || !g.Members.Contains(current, Ids)) continue;
                if (!seen.Add(g.Id)) continue;
                yield return g.Id;
                queue.Enqueue(g.Id);
            }
        }
    }
}
