using System.Collections.Concurrent;

namespace rPDU2MQTT.Core.Flow;

/// <summary>
/// The guard on a lifetime counter: a value that goes backwards is not published.
///
/// <para>
/// These figures feed sensors declared <c>state_class: total_increasing</c>. Home Assistant reads a decrease
/// in such a series as a meter reset and takes the next reading as a delta from zero — so one dip records an
/// entire lifetime counter as a single period's usage. A week of 12 MWh days against a house using tens of
/// kWh is what that looks like.
/// </para>
/// <para>
/// A roll-up dips without anything being wrong with the meter: <see cref="FlowExport.TryNodeValue"/> sums the
/// links whose flow is known, so a contributor going stale makes the parent's total smaller. That total is
/// not the node's energy, it is the energy of the part that happened to be reporting, and publishing it does
/// permanent damage to the statistics on the other side.
/// </para>
/// <para>
/// So a decrease is withheld rather than published, and the sensor holds its last good value until the
/// reading climbs past the mark again — which is what happens by itself when the missing contributor
/// comes back.
/// </para>
/// <para>
/// Withholding is bounded in both directions, because a mark that the series can never reach again is a
/// sensor that publishes nothing and never says why. A decrease inside the consumer's own reset threshold
/// is published as the noise it is, and a reading that stays below the mark for
/// <see cref="RebaselineAfter"/> re-baselines onto it: a stale contributor comes back within that window,
/// a series measured from a new origin never does.
/// </para>
/// </summary>
public sealed class CumulativeExport
{
    private readonly ConcurrentDictionary<string, double> peak = new(StringComparer.Ordinal);
    private readonly IEnergyStore? store;

    public CumulativeExport() { }

    /// <summary>
    /// Backed by a store, so the marks survive a restart.
    ///
    /// <para>
    /// Without one the guard is re-baselined every time the process starts: the first pass takes whatever
    /// the raw counter reads as the new peak and publishes it, and where that sits below what has already
    /// gone out, the consumer reads a meter reset and counts the whole climb again. That is the failure
    /// this class exists to prevent, arriving through the back door.
    /// </para>
    /// </summary>
    public CumulativeExport(IEnergyStore store)
    {
        this.store = store;
        foreach (var (key, high) in store.LoadPeaks()) peak[key] = high;
    }

    /// <summary>What was withheld and why, newest reason per key, for the diagnostics the GUI reads.</summary>
    private readonly ConcurrentDictionary<string, string> withheld = new(StringComparer.Ordinal);

    /// <summary>When each withheld key first went below its mark, so a dip can be told from a new series.</summary>
    private readonly ConcurrentDictionary<string, DateTime> belowSince = new(StringComparer.Ordinal);

    /// <summary>A decrease this small is measurement noise, not a reset — Home Assistant's own total_increasing threshold.</summary>
    private const double ResetFraction = 0.9;

    /// <summary>How long a reading stays below the mark before the mark is treated as belonging to a series this key no longer carries.</summary>
    public static readonly TimeSpan RebaselineAfter = TimeSpan.FromHours(6);

    /// <summary>
    /// The value to publish for <paramref name="key"/>, or null when it must not be published.
    /// A null <paramref name="value"/> stays null — nothing measured is not a decrease.
    /// </summary>
    public double? Publish(string key, double? value, DateTime nowUtc = default)
    {
        if (value is not { } v) return null;
        if (nowUtc == default) nowUtc = DateTime.UtcNow;

        // TryGetValue, not GetOrAdd: GetOrAdd inserts the key before the comparison below can tell a first
        // sighting from an unchanged one, so nothing was ever recognised as moved and nothing was persisted.
        var known = peak.TryGetValue(key, out var high);
        // A dip within the consumer's own reset threshold is not read as a reset there either, so holding it
        // back buys nothing and cost 20 outlets their sensor over a thousandth of a kWh of save-ordering jitter.
        if (known && v < high && v < high * ResetFraction)
        {
            var since = belowSince.GetOrAdd(key, nowUtc);
            var waited = nowUtc - since;
            if (waited < RebaselineAfter)
            {
                withheld[key] = $"{v:0.###} is below the {high:0.###} already published. A lifetime counter that "
                              + "goes backwards is read as a meter reset, and the next reading would be recorded "
                              + "as a whole counter's worth of usage. If it stays down it is a different series, "
                              + $"and the mark re-baselines onto it after {(RebaselineAfter - waited).TotalHours:0.#}h.";
                return null;
            }
            // Sustained: a stale contributor comes back, a re-based series never does. Holding the mark past
            // that point is not caution, it is a sensor that never publishes again and never says why.
            Log.Warning($"Energy export: '{key}' has read below its {high:0.###} high-water mark for "
                      + $"{RebaselineAfter.TotalHours:0}h and is now {v:0.###}. Treating the mark as belonging to a "
                      + "series this key no longer carries and re-baselining onto the current reading.");
        }

        withheld.TryRemove(key, out _);
        belowSince.TryRemove(key, out _);
        var moved = !known || v > high;
        peak[key] = v;
        if (moved || v < high) store?.SavePeak(key, v);
        return v;
    }

    /// <summary>Keys currently being withheld, with the reason.</summary>
    public IReadOnlyCollection<(string Key, string Reason)> Withheld
        => withheld.Select(kv => (kv.Key, kv.Value)).ToList();

    /// <summary>Forget what has been seen — for tests, and for a deliberate re-baseline.</summary>
    public void Reset() { peak.Clear(); withheld.Clear(); belowSince.Clear(); }
}
