namespace rPDU2MQTT.Core.Flow;

/// <summary>
/// Energy over a window of days, from the daily totals that already exist.
///
/// </summary>
public static class FlowSpan
{
    /// <summary>The metric a span can be taken over. Anything else is refused.</summary>
    public const string SpannableMetric = "energytoday";

    // Which instants represent the last N days is EnergyPeriod.RecentPeriodEnds, and only that. This class

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
