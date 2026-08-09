namespace rPDU2MQTT.Core.Flow;

/// <summary>
/// Energy over a window of days, from the daily totals that already exist.
///
/// <para>
/// A week's energy is the sum of seven days' totals — and only those. Daily totals all re-base at the same
/// moment, so they can be added; lifetime counters cannot (a PDU's has run since it was commissioned, a
/// node's since you bound it), and an instantaneous power reading is not a quantity of energy at all. So a
/// span is offered for the daily total and refused for everything else, rather than quietly summing
/// figures that do not add up.
/// </para>
/// <para>
/// A day the backend has nothing for is a day missing from the sum, not a zero. The fold counts what it
/// actually saw per node so the caller can say "5 of 7 days" instead of presenting a short week as a whole
/// one.
/// </para>
/// </summary>
public static class FlowSpan
{
    /// <summary>The metric a span can be taken over. Anything else is refused.</summary>
    public const string SpannableMetric = "energytoday";

    /// <summary>
    /// The instants to sample, one per day, ending at <paramref name="end"/> and walking back. The same
    /// time of day each time: whatever moment the caller asked for is what each day is measured at, so a
    /// window ending at a day's last second is made of whole days.
    /// </summary>
    public static IReadOnlyList<DateTime> Days(DateTime end, int days)
    {
        var count = Math.Max(1, days);
        var list = new List<DateTime>(count);
        for (var i = count - 1; i >= 0; i--) list.Add(end.AddDays(-i));
        return list;
    }

    /// <summary>
    /// Add up one reading per node per day, and count the days each node actually had.
    /// </summary>
    public static (Dictionary<string, double> Totals, Dictionary<string, int> Days) Fold(
        IEnumerable<IReadOnlyDictionary<string, double>> daily)
    {
        var totals = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);
        var days = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        foreach (var day in daily)
        {
            foreach (var (node, value) in day)
            {
                totals[node] = totals.TryGetValue(node, out var t) ? t + value : value;
                days[node] = days.TryGetValue(node, out var d) ? d + 1 : 1;
            }
        }
        return (totals, days);
    }

    /// <summary>
    /// The nodes whose window is short, with the number of days each actually covered. Empty when every
    /// node that reported at all reported for the whole window.
    /// </summary>
    public static IReadOnlyList<(string Node, int Days)> Incomplete(IReadOnlyDictionary<string, int> days, int expected)
        => days.Where(kv => kv.Value < expected)
               .OrderBy(kv => kv.Key, StringComparer.Ordinal)
               .Select(kv => (kv.Key, kv.Value))
               .ToList();
}
