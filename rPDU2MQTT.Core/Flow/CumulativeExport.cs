using System.Collections.Concurrent;

namespace rPDU2MQTT.Core.Flow;

/// <summary>
/// The guard on a lifetime counter: a value lower than the highest already published is never published.
///
/// <para>
/// These figures feed sensors declared <c>state_class: total_increasing</c>. Home Assistant reads a decrease
/// in such a series as a meter reset and takes the next reading as a delta from zero — so one dip records an
/// entire lifetime counter as a single period's usage.
/// </para>
/// <para>
/// The comparison is absolute and has no exceptions. Earlier versions carved out two: a decrease under a
/// tenth was let through as noise, and a reading that stayed low for six hours re-baselined the mark onto
/// itself. Both published a decrease, which is the one thing this class exists to prevent, and the second
/// one booked 183.5 kWh of solar into a single 04:00 hour on 2026-09-10.
/// </para>
/// <para>
/// A mark that the live series can never reach again does leave a sensor dark. That is an operator decision,
/// not one to take automatically: <see cref="Withheld"/> names every such key and why, and clearing the
/// stored mark (delete the peaks key, then restart) is the deliberate way to move one.
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

    /// <summary>
    /// The value to publish for <paramref name="key"/>, or null when it must not be published.
    /// A null <paramref name="value"/> stays null — nothing measured is not a decrease.
    /// </summary>
    public double? Publish(string key, double? value)
    {
        if (value is not { } v) return null;

        // TryGetValue, not GetOrAdd: GetOrAdd inserts the key before the comparison below can tell a first
        // sighting from an unchanged one, so nothing was ever recognised as moved and nothing was persisted.
        if (peak.TryGetValue(key, out var high) && v < high)
        {
            withheld[key] = $"{v:0.###} is below the {high:0.###} already published. A lifetime counter that "
                          + "goes backwards is read as a meter reset, and the next reading would be recorded "
                          + "as a whole counter's worth of usage. The mark only moves up; clear the stored "
                          + "peak and restart to re-baseline this key deliberately.";
            return null;
        }

        withheld.TryRemove(key, out _);
        var moved = !peak.TryGetValue(key, out var known) || v > known;
        peak[key] = v;
        if (moved) store?.SavePeak(key, v);
        return v;
    }

    /// <summary>Keys currently being withheld, with the reason.</summary>
    public IReadOnlyCollection<(string Key, string Reason)> Withheld
        => withheld.Select(kv => (kv.Key, kv.Value)).ToList();

    /// <summary>Forget what has been seen — for tests, and for a deliberate re-baseline.</summary>
    public void Reset() { peak.Clear(); withheld.Clear(); }
}
