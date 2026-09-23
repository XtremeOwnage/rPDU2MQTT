using rPDU2MQTT.Models.Config;

namespace rPDU2MQTT.Core.Flow;

/// <summary>What a place's total is (#461, #466).</summary>
public static class LocationState
{
    /// <summary>Every reading the total depends on is known.</summary>
    public const string Known = "known";
    /// <summary>Something is metered here, but a reading the total depends on is missing. Never shown as 0.</summary>
    public const string Unknown = "unknown";
    /// <summary>Nothing metered is in this place.</summary>
    public const string Unmetered = "unmetered";
}

/// <summary>A place's rolled-up value, and what it rests on.</summary>
/// <param name="Nodes">The nodes whose consumption is in this place.</param>
/// <param name="Missing">The readings the total needed and did not have.</param>
/// <param name="Split">Nodes fed from both inside and outside the place, whose share cannot be told apart.</param>
public sealed record LocationTotal(string Id, double? Value, string State, IReadOnlyList<string> Nodes,
    IReadOnlyList<string> Missing, IReadOnlyList<string> Split)
{
    public static LocationTotal Unmetered(string id) => new(id, null, LocationState.Unmetered, [], [], []);
}

/// <summary>
/// Energy rolled up the location tree (#461): device → room → floor → site, beside the electrical hierarchy.
/// </summary>
public static class LocationRollup
{
    private static readonly StringComparer Ids = StringComparer.OrdinalIgnoreCase;

    /// <summary>
    /// Where each node's consumption is: its own location, else its feeder's when every feeder agrees. A node
    /// fed from two places, or from nowhere placed, is in no place.
    /// </summary>
    public static IReadOnlyDictionary<string, string> Placed(LocationIndex index, FlowTopology topology)
    {
        var placed = new Dictionary<string, string?>(Ids);
        string? Of(string id, HashSet<string> visiting)
        {
            if (placed.TryGetValue(id, out var known)) return known;
            if (index.LocationOf(id) is { } own) return placed[id] = own;
            if (!visiting.Add(id)) return null;
            var from = topology.Feeders(id).Select(f => Of(f, visiting)).Distinct(Ids).ToList();
            visiting.Remove(id);
            return placed[id] = from.Count == 1 ? from[0] : null;
        }
        foreach (var n in topology.Nodes) Of(n, new HashSet<string>(Ids));
        return placed.Where(kv => kv.Value is not null).ToDictionary(kv => kv.Key, kv => kv.Value!, Ids);
    }

    /// <summary>
    /// Every place's total. What enters the place is counted and what leaves it is taken off, so a reading inside
    /// the place is never needed twice and a node between two others in the same place need not be metered at all.
    /// A total that needs a reading nobody has is unknown, not a partial sum.
    /// </summary>
    public static IReadOnlyDictionary<string, LocationTotal> Compute(LocationIndex index, FlowTopology topology, Func<string, double?> valueOf)
    {
        var placed = Placed(index, topology);
        var totals = new Dictionary<string, LocationTotal>(Ids);
        foreach (var place in index.All)
        {
            var inside = placed.Where(kv => index.Within(kv.Value, place.Id)).Select(kv => kv.Key).ToHashSet(Ids);
            totals[place.Id] = Total(place.Id, inside, topology, valueOf);
        }
        return totals;
    }

    /// <summary>The total of a set of nodes: what flows in from outside it, less what flows back out.</summary>
    public static LocationTotal Total(string id, IReadOnlySet<string> inside, FlowTopology topology, Func<string, double?> valueOf)
    {
        if (inside.Count == 0) return LocationTotal.Unmetered(id);

        double total = 0;
        var missing = new List<string>();
        var split = new List<string>();

        foreach (var n in inside.OrderBy(x => x, Ids))
        {
            var feeders = topology.Feeders(n);
            var fedInside = feeders.Count(f => inside.Contains(f));
            // Fed only from within: its reading is already in its feeder's, and cancels against what left it.
            if (fedInside == feeders.Count && feeders.Count > 0) continue;
            if (fedInside > 0) { split.Add(n); continue; }
            if (valueOf(n) is { } v) total += v; else missing.Add(n);
        }

        var leaving = inside.SelectMany(n => topology.Children(n)).Where(c => !inside.Contains(c)).Distinct(Ids).OrderBy(x => x, Ids);
        foreach (var c in leaving)
        {
            var value = valueOf(c);
            // A node fed from both sides of the line takes an unknown share from each, unless it draws nothing.
            if (topology.Feeders(c).Any(f => !inside.Contains(f)) && value is not 0) { split.Add(c); continue; }
            if (value is { } v) total -= v; else missing.Add(c);
        }

        var known = missing.Count == 0 && split.Count == 0;
        return new LocationTotal(id, known ? total : null, known ? LocationState.Known : LocationState.Unknown,
            inside.OrderBy(x => x, Ids).ToList(), missing, split.Distinct(Ids).ToList());
    }
}
