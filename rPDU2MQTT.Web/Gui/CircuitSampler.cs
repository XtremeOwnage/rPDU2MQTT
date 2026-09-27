using rPDU2MQTT.Core.Flow;

namespace rPDU2MQTT.Services.Gui;

/// <summary>
/// The readings behind the Circuit Finder (#494): every channel, recorded at a steady rate for as long as the
/// page keeps asking, kept for half an hour.
///
/// <para>
/// The page used to read the channels itself, once per tap and then in the background while it stayed open
/// and in front — so a phone that locked its screen between switching the load and tapping collected
/// nothing, and a state entered and left quickly held one noisy reading. Recorded here, a tap is only a
/// timestamp: the state it opens is every reading taken until the next tap, however the phone spent that
/// time.
/// </para>
/// </summary>
public sealed class CircuitSampler
{
    /// <summary>How far back a session can reach.</summary>
    public static readonly TimeSpan Keep = TimeSpan.FromMinutes(30);

    /// <summary>How long recording carries on after the page last asked; a phone left on a shelf stops it.</summary>
    public static readonly TimeSpan ArmFor = TimeSpan.FromMinutes(10);

    /// <summary>One reading of every channel.</summary>
    public sealed record Sample(DateTime At, IReadOnlyDictionary<string, double> Values);

    private readonly object gate = new();
    private readonly List<Sample> samples = [];
    private readonly Dictionary<string, (string Label, string Kind)> channels = new(StringComparer.Ordinal);
    private DateTime armedUntil = DateTime.MinValue;
    private bool running;

    /// <summary>Keep recording for <see cref="ArmFor"/> from now. True when nothing is recording yet, and the caller starts it.</summary>
    public bool Arm(DateTime now)
    {
        lock (gate)
        {
            armedUntil = now + ArmFor;
            if (running) return false;
            running = true;
            return true;
        }
    }

    /// <summary>Whether to take another reading. Once this says no, the next <see cref="Arm"/> starts a new recorder.</summary>
    public bool KeepGoing(DateTime now)
    {
        lock (gate)
        {
            if (now < armedUntil) return true;
            running = false;
            return false;
        }
    }

    /// <summary>
    /// Record what every channel reads. A reading identical to the last one is the same poll seen again, not a
    /// second measurement, so it is not counted twice. Returns whether it was kept.
    /// </summary>
    public bool Record(DateTime at, IEnumerable<FlowNode> nodes)
    {
        var values = new Dictionary<string, double>(StringComparer.Ordinal);
        lock (gate)
        {
            foreach (var n in nodes)
            {
                // A return lane or an unmetered remainder is not a channel a load can be found on.
                if (n.Synthetic || n.Value is not { } v || !double.IsFinite(v)) continue;
                values[n.Id] = v;
                channels[n.Id] = (n.Label, n.Kind);
            }
            if (values.Count == 0) return false;
            if (samples.Count > 0 && Same(samples[^1].Values, values)) return false;
            samples.Add(new Sample(at, values));
            var cutoff = at - Keep;
            var old = samples.FindIndex(s => s.At >= cutoff);
            if (old > 0) samples.RemoveRange(0, old);
            return true;
        }
    }

    /// <summary>The readings taken after <paramref name="since"/>, and the name and kind of every channel seen.</summary>
    public (IReadOnlyList<Sample> Samples, IReadOnlyDictionary<string, (string Label, string Kind)> Channels) Since(DateTime since)
    {
        lock (gate)
            return (samples.Where(s => s.At > since).ToList(), new Dictionary<string, (string, string)>(channels));
    }

    private static bool Same(IReadOnlyDictionary<string, double> a, IReadOnlyDictionary<string, double> b)
        => a.Count == b.Count && a.All(kv => b.TryGetValue(kv.Key, out var v) && v.Equals(kv.Value));
}
