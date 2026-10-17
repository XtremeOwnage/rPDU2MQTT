namespace rPDU2MQTT.Core.Flow;

/// <summary>
/// An untracked node's lifetime total, kept live: each pass adds what its parent's counter rose beyond the rises
/// of its tracked siblings. The parent's counter less its siblings' is not a counter — it leaps when a sibling is
/// added and drifts down when the siblings' meters read a little high — so it cannot be published as one. This is
/// the live form of <see cref="UntrackedSeries.Rebuild"/>.
/// </summary>
public sealed class UntrackedCounter
{
    private static readonly StringComparer Ids = StringComparer.OrdinalIgnoreCase;
    private readonly Dictionary<string, Dictionary<string, double>> marks = new(Ids);
    private readonly Dictionary<string, double> totals = new(Ids);

    /// <summary>
    /// Advance <paramref name="plan"/>'s node from the members' current counters and return its total, which starts
    /// at 0 in each process (the export carries it on from the published mark). Null until the parent has read once.
    /// A step is skipped when the parent has no reading, or a sibling that was reporting has stopped; a counter
    /// that falls is re-baselined rather than read as a reset, since a live reading cannot see whether it recovers.
    /// </summary>
    public double? Advance(UntrackedSeries.Plan plan, Func<string, double?> reading)
    {
        if (!marks.TryGetValue(plan.Node, out var mark)) marks[plan.Node] = mark = new(Ids);
        var total = totals.TryGetValue(plan.Node, out var t) ? t : (double?)null;

        if (reading(plan.Parent) is not { } parentNow)
        {
            mark.Clear();
            return total;
        }
        total ??= 0;

        var now = new Dictionary<string, double>(Ids) { [plan.Parent] = parentNow };
        var gap = !mark.ContainsKey(plan.Parent);
        foreach (var sibling in plan.Tracked)
        {
            if (reading(sibling) is { } v) now[sibling] = v;
            else if (mark.ContainsKey(sibling)) gap = true;   // was reporting; this step cannot be apportioned
        }

        if (!gap)
        {
            double Rise(string id) => mark.TryGetValue(id, out var m) && now[id] >= m ? now[id] - m : 0;
            // A sibling just come back has no mark to rise from, so this step goes uncounted rather than unsubtracted.
            if (now.Keys.All(mark.ContainsKey))
                total += Math.Max(0, Rise(plan.Parent) - now.Keys.Where(k => !Ids.Equals(k, plan.Parent)).Sum(Rise));
        }

        mark.Clear();
        foreach (var (id, v) in now) mark[id] = v;
        totals[plan.Node] = total.Value;
        return total;
    }
}
