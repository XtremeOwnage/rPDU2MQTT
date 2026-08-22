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
/// So a decrease is withheld rather than published. The consequence is deliberate and bounded: the sensor
/// holds its last good value until the reading climbs past it again, which is what happens by itself when
/// the missing contributor comes back. A counter that genuinely restarts — a replaced meter — stays withheld
/// until it passes its old peak or the bridge restarts, which is the safer way round: the alternative
/// rewrites history that cannot be recovered.
/// </para>
/// </summary>
public sealed class CumulativeExport
{
    private readonly ConcurrentDictionary<string, double> peak = new(StringComparer.Ordinal);

    /// <summary>What was withheld and why, newest reason per key, for the diagnostics the GUI reads.</summary>
    private readonly ConcurrentDictionary<string, string> withheld = new(StringComparer.Ordinal);

    /// <summary>
    /// The value to publish for <paramref name="key"/>, or null when it must not be published.
    /// A null <paramref name="value"/> stays null — nothing measured is not a decrease.
    /// </summary>
    public double? Publish(string key, double? value)
    {
        if (value is not { } v) return null;

        var high = peak.GetOrAdd(key, v);
        if (v < high)
        {
            withheld[key] = $"{v:0.###} is below the {high:0.###} already published. A lifetime counter that "
                          + "goes backwards is read as a meter reset, and the next reading would be recorded "
                          + "as a whole counter's worth of usage.";
            return null;
        }

        withheld.TryRemove(key, out _);
        peak[key] = v;
        return v;
    }

    /// <summary>Keys currently being withheld, with the reason.</summary>
    public IReadOnlyCollection<(string Key, string Reason)> Withheld
        => withheld.Select(kv => (kv.Key, kv.Value)).ToList();

    /// <summary>Forget what has been seen — for tests, and for a deliberate re-baseline.</summary>
    public void Reset() { peak.Clear(); withheld.Clear(); }
}
