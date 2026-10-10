using System.Collections.Concurrent;

namespace rPDU2MQTT.Core.Flow;

/// <summary>The guard on a lifetime counter: a value below the highest already published is never published.</summary>
public sealed class CumulativeExport
{
    private readonly ConcurrentDictionary<string, double> peak = new(StringComparer.Ordinal);
    private readonly IEnergyStore? store;

    public CumulativeExport() { }

    /// <summary>Backed by a store, so the marks survive a restart rather than re-baselining on every start.</summary>
    public CumulativeExport(IEnergyStore store)
    {
        this.store = store;
        foreach (var (key, high) in store.LoadPeaks())
            if (key.EndsWith(OffsetSuffix, StringComparison.Ordinal)) offset[key[..^OffsetSuffix.Length]] = high;
            else peak[key] = high;
    }

    private const string OffsetSuffix = "@offset";
    private readonly ConcurrentDictionary<string, double> offset = new(StringComparer.Ordinal);

    /// <summary>
    /// A running total that must never go backwards, carried on from the mark: a drop moves the offset, not the published value.
    /// </summary>
    public double? Continue(string key, double? total)
    {
        if (total is not { } t) return null;

        var first = !offset.TryGetValue(key, out var off);
        var v = t + off;
        // First use picks up exactly where the mark stands, so the switch is neither a reset nor a jump.
        if (peak.TryGetValue(key, out var high) && (first || v < high))
        {
            off += high - v;
            v = high;
        }
        if (first || off != offset[key])
        {
            offset[key] = off;
            store?.SavePeak(key + OffsetSuffix, off);
        }

        withheld.TryRemove(key, out _);
        if (!peak.TryGetValue(key, out var known) || v > known)
        {
            peak[key] = v;
            store?.SavePeak(key, v);
        }
        return v;
    }

    /// <summary>What was withheld and why, newest reason per key, for the diagnostics the GUI reads.</summary>
    private readonly ConcurrentDictionary<string, string> withheld = new(StringComparer.Ordinal);

    /// <summary>The value to publish for <paramref name="key"/>, or null when it must not be published.</summary>
    public double? Publish(string key, double? value)
    {
        if (value is not { } v) return null;

        // TryGetValue, not GetOrAdd: GetOrAdd inserts before the comparison can tell a first sighting from an unchanged one.
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
    public void Reset() { peak.Clear(); withheld.Clear(); offset.Clear(); }
}
