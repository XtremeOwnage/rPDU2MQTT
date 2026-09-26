using System.Security.Cryptography;
using System.Text;

namespace rPDU2MQTT.Core.History;

/// <summary>One resolution of one series: how often it is stored, how it is chunked, and how long it is kept.</summary>
/// <param name="Name">The directory the tier's chunks live in, and what a read names when it says where a figure came from.</param>
/// <param name="IntervalSeconds">Seconds a slot covers.</param>
/// <param name="Chunk">How much time one file holds.</param>
/// <param name="KeepDays">How long a chunk is kept once it is complete.</param>
public sealed record SeriesTier(string Name, int IntervalSeconds, ChunkSpan Chunk, int KeepDays);

/// <summary>How much time one file holds. Retention is then deleting whole files rather than rewriting any.</summary>
public enum ChunkSpan { Day, Month, Year }

/// <summary>
/// The bridge's own history: a directory of fixed-interval files, one per series per tier per chunk (#502).
///
/// <para>
/// Nothing is indexed and nothing is queried: a reading's place is arithmetic, so a window is a seek and a
/// sequential read. The directory is the whole database — copy it, tar it, mount it read-only — and a chunk
/// is a plain file whose layout is documented in <see cref="SeriesFile"/>.
/// </para>
/// <para>
/// Three tiers, because a year of ten-second readings is millions of slots to walk for a chart of thirty
/// days: the readings as they arrive, a minute, and an hour. A coarser tier holds the <b>last</b> reading of
/// each bucket, which is what every read asks for anyway — the value as of that moment — and keeps a
/// counter's meaning intact, which an average would not.
/// </para>
/// </summary>
public sealed class LocalSeriesStore
{
    private static readonly StringComparer Ids = StringComparer.OrdinalIgnoreCase;

    public string Root { get; }
    public IReadOnlyList<SeriesTier> Tiers { get; }

    /// <summary>How far back a read looks for the reading that was standing at a moment.</summary>
    private readonly int toleranceSeconds;

    public LocalSeriesStore(string root, int rawIntervalSeconds = 10, int toleranceSeconds = 30,
                            int rawKeepDays = 7, int minuteKeepDays = 90, int hourKeepDays = 3650)
    {
        Root = root;
        this.toleranceSeconds = Math.Max(1, toleranceSeconds);
        Tiers =
        [
            new SeriesTier("raw", Math.Max(1, rawIntervalSeconds), ChunkSpan.Day, Math.Max(1, rawKeepDays)),
            new SeriesTier("minute", 60, ChunkSpan.Month, Math.Max(1, minuteKeepDays)),
            new SeriesTier("hour", 3600, ChunkSpan.Year, Math.Max(1, hourKeepDays)),
        ];
    }

    private SeriesTier Raw => Tiers[0];

    // --- Where a series lives ------------------------------------------------------------------------

    /// <summary>
    /// The directory one series' chunks live in. A node id carries characters a filesystem argues about
    /// (<c>outlet:pdu:1</c>, <c>main#in</c>), so the name is cleaned for reading and a hash of the original
    /// keeps two different series from ever meeting in the same directory.
    /// </summary>
    public static string FolderFor(string node, string metric)
    {
        var key = $"{node}|{metric}";
        var clean = new StringBuilder(key.Length);
        foreach (var c in key) clean.Append(char.IsLetterOrDigit(c) || c is '-' or '_' or '.' ? c : '_');
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key)))[..8].ToLowerInvariant();
        var name = clean.ToString();
        if (name.Length > 96) name = name[..96];
        return $"{name}.{hash}";
    }

    private string PathFor(string node, string metric, SeriesTier tier, DateTime whenUtc)
        => Path.Combine(Root, FolderFor(node, metric), tier.Name, $"{ChunkName(tier.Chunk, whenUtc)}.rts");

    private static string ChunkName(ChunkSpan span, DateTime whenUtc) => span switch
    {
        ChunkSpan.Day => whenUtc.ToString("yyyyMMdd"),
        ChunkSpan.Month => whenUtc.ToString("yyyyMM"),
        _ => whenUtc.ToString("yyyy"),
    };

    /// <summary>The moment a chunk begins — where its slot 0 sits.</summary>
    public static DateTime ChunkStart(ChunkSpan span, DateTime whenUtc)
    {
        var at = DateTime.SpecifyKind(whenUtc, DateTimeKind.Utc);
        return span switch
        {
            ChunkSpan.Day => new DateTime(at.Year, at.Month, at.Day, 0, 0, 0, DateTimeKind.Utc),
            ChunkSpan.Month => new DateTime(at.Year, at.Month, 1, 0, 0, 0, DateTimeKind.Utc),
            _ => new DateTime(at.Year, 1, 1, 0, 0, 0, DateTimeKind.Utc),
        };
    }

    private SeriesFile Chunk(string node, string metric, SeriesTier tier, DateTime whenUtc)
        => SeriesFile.Create(PathFor(node, metric, tier, whenUtc), tier.IntervalSeconds, ChunkStart(tier.Chunk, whenUtc));

    private SeriesFile? ExistingChunk(string node, string metric, SeriesTier tier, DateTime whenUtc)
        => SeriesFile.Open(PathFor(node, metric, tier, whenUtc));

    // --- Writing -------------------------------------------------------------------------------------

    /// <summary>Store one reading, at the resolution it arrived. A value that is not a number is not stored.</summary>
    public void Write(string node, string metric, DateTime atUtc, double value)
    {
        if (string.IsNullOrWhiteSpace(node) || string.IsNullOrWhiteSpace(metric) || !double.IsFinite(value)) return;
        var chunk = Chunk(node, metric, Raw, atUtc);
        chunk.Write(chunk.SlotOf(atUtc), value);
    }

    /// <summary>
    /// Store a sweep of readings taken at one moment: the readings of a series are written together, so a
    /// sweep of two hundred nodes costs one open per series rather than one per reading.
    /// </summary>
    public void WriteSweep(DateTime atUtc, IEnumerable<(string Node, string Metric, double Value)> readings)
    {
        foreach (var series in readings.Where(r => double.IsFinite(r.Value))
                                       .GroupBy(r => (r.Node, r.Metric)))
        {
            var chunk = Chunk(series.Key.Node, series.Key.Metric, Raw, atUtc);
            var slot = chunk.SlotOf(atUtc);
            chunk.WriteMany(series.Select(r => (slot, r.Value)));
        }
    }

    // --- Reading -------------------------------------------------------------------------------------

    /// <summary>
    /// The tier a window is best answered from: the coarsest one still finer than the step, since anything
    /// finer is read and thrown away — and only among the tiers that still keep the oldest moment asked for.
    /// A step finer than every tier is answered by the finest that is left.
    /// </summary>
    public SeriesTier TierFor(DateTime oldestUtc, int stepSeconds, DateTime nowUtc)
    {
        var kept = Tiers.Where(t => oldestUtc >= nowUtc.AddDays(-t.KeepDays)).ToList();
        if (kept.Count == 0) return Tiers[^1];
        return kept.LastOrDefault(t => t.IntervalSeconds <= Math.Max(1, stepSeconds)) ?? kept[0];
    }

    /// <summary>How far back a read looks for the reading standing at a moment, in that tier's slots.</summary>
    private int LookBack(SeriesTier tier) => tier == Raw
        ? Math.Max(1, (int)Math.Ceiling(Math.Max(toleranceSeconds, 5.0 * tier.IntervalSeconds) / tier.IntervalSeconds))
        : 2;

    /// <summary>What a series read at one moment, or NaN when nothing was stored around it.</summary>
    public double ValueAt(string node, string metric, DateTime atUtc, DateTime? nowUtc = null)
        => AnyTier(node, metric, atUtc, TierFor(atUtc, 1, nowUtc ?? DateTime.UtcNow));

    /// <summary>
    /// The chosen tier's answer, else any other tier's. A coarser tier is an optimisation, not the truth:
    /// until a roll-up has run — the first hours of a new install — only the raw tier holds anything, and a
    /// tier that has been trimmed holds nothing however fine it is.
    /// </summary>
    private double AnyTier(string node, string metric, DateTime atUtc, SeriesTier first)
    {
        var value = FromTier(node, metric, first, atUtc);
        if (!double.IsNaN(value)) return value;
        foreach (var tier in Tiers)
        {
            if (tier == first) continue;
            value = FromTier(node, metric, tier, atUtc);
            if (!double.IsNaN(value)) return value;
        }
        return double.NaN;
    }

    private double FromTier(string node, string metric, SeriesTier tier, DateTime atUtc)
    {
        var chunk = ExistingChunk(node, metric, tier, atUtc);
        if (chunk is not null)
        {
            var found = chunk.At(chunk.SlotOf(atUtc), LookBack(tier));
            if (!double.IsNaN(found)) return found;
        }

        // The moment may be the first of a chunk — or in one that was never started — with the reading that
        // was standing written in the chunk before. One back is enough: beyond that it is too old to stand.
        var previous = ExistingChunk(node, metric, tier, ChunkStart(tier.Chunk, atUtc).AddSeconds(-1));
        if (previous is null) return double.NaN;
        var lastSlot = previous.Slots() - 1;
        var gap = (atUtc - previous.TimeOf(lastSlot)).TotalSeconds;
        return gap >= 0 && gap <= LookBack(tier) * (double)tier.IntervalSeconds ? previous.At(lastSlot, LookBack(tier)) : double.NaN;
    }

    /// <summary>One reading per step, NaN where the series has none. Steps are expected in time order.</summary>
    public double[] Series(string node, string metric, IReadOnlyList<DateTime> steps, DateTime? nowUtc = null)
    {
        var values = new double[steps.Count];
        Array.Fill(values, double.NaN);
        if (steps.Count == 0) return values;

        var now = nowUtc ?? DateTime.UtcNow;
        var stepSeconds = steps.Count > 1
            ? Math.Max(1, (int)Math.Round((steps[^1] - steps[0]).TotalSeconds / (steps.Count - 1)))
            : 1;
        var tier = TierFor(steps[0], stepSeconds, now);

        // Walked chunk by chunk: the steps of one file are read in one pass rather than a seek per step.
        var at = 0;
        while (at < steps.Count)
        {
            var chunkStart = ChunkStart(tier.Chunk, steps[at]);
            var chunk = ExistingChunk(node, metric, tier, steps[at]);
            var last = at;
            while (last + 1 < steps.Count && ChunkStart(tier.Chunk, steps[last + 1]) == chunkStart) last++;

            if (chunk is not null)
            {
                var first = Math.Max(0, chunk.SlotOf(steps[at]) - LookBack(tier));
                var end = chunk.SlotOf(steps[last]);
                var window = chunk.Read(first, (int)(end - first + 1));
                for (var i = at; i <= last; i++)
                {
                    var slot = chunk.SlotOf(steps[i]) - first;
                    for (var back = Math.Min(slot, window.Length - 1); back >= 0 && slot - back <= LookBack(tier); back--)
                        if (!double.IsNaN(window[back])) { values[i] = window[back]; break; }
                }
            }
            // A step this chunk had nothing for may still be answered by the chunk before it, or by another
            // tier — the roll-ups may not have caught up, or this one may have been trimmed.
            for (var i = at; i <= last; i++)
                if (double.IsNaN(values[i])) values[i] = AnyTier(node, metric, steps[i], tier);
            at = last + 1;
        }
        return values;
    }

    // --- Keeping it small ----------------------------------------------------------------------------

    /// <summary>Every series the store holds, as (node, metric) cannot be recovered from a folder name.</summary>
    public IReadOnlyList<string> Folders()
    {
        try
        {
            return Directory.Exists(Root)
                ? Directory.GetDirectories(Root).Select(d => Path.GetFileName(d) ?? "").Where(n => n.Length > 0).ToList()
                : [];
        }
        catch (IOException) { return []; }
    }

    /// <summary>
    /// Fill the coarser tiers from the finer ones, for the recent buckets only. Re-running it changes
    /// nothing: a bucket's value is the last reading in it, whenever it is worked out.
    /// </summary>
    public void Rollup(string node, string metric, DateTime nowUtc, int buckets = 180)
    {
        for (var i = 1; i < Tiers.Count; i++)
        {
            var coarse = Tiers[i];
            var fine = Tiers[i - 1];
            var writes = new List<(DateTime At, double Value)>();
            for (var back = buckets; back >= 1; back--)
            {
                // Only buckets that have finished: one still filling would be stored as whatever it held.
                var end = Floor(nowUtc, coarse.IntervalSeconds).AddSeconds(-(long)(back - 1) * coarse.IntervalSeconds);
                if (end > nowUtc) continue;
                var value = LastIn(node, metric, fine, end.AddSeconds(-coarse.IntervalSeconds), end);
                if (!double.IsNaN(value)) writes.Add((end.AddSeconds(-coarse.IntervalSeconds), value));
            }
            foreach (var group in writes.GroupBy(w => ChunkStart(coarse.Chunk, w.At)))
            {
                var chunk = Chunk(node, metric, coarse, group.Key);
                chunk.WriteMany(group.Select(w => (chunk.SlotOf(w.At), w.Value)));
            }
        }
    }

    /// <summary>The last reading a tier holds in [from, to), or NaN when it holds none.</summary>
    private double LastIn(string node, string metric, SeriesTier tier, DateTime from, DateTime to)
    {
        var value = double.NaN;
        for (var chunkAt = ChunkStart(tier.Chunk, from); chunkAt < to; chunkAt = Next(tier.Chunk, chunkAt))
        {
            var chunk = ExistingChunk(node, metric, tier, chunkAt);
            if (chunk is null) continue;
            var first = Math.Max(0, chunk.SlotOf(from));
            var end = chunk.SlotOf(to.AddSeconds(-1));
            if (end < first) continue;
            var window = chunk.Read(first, (int)(end - first + 1));
            for (var i = window.Length - 1; i >= 0; i--)
                if (!double.IsNaN(window[i])) { value = window[i]; break; }
        }
        return value;
    }

    private static DateTime Next(ChunkSpan span, DateTime at) => span switch
    {
        ChunkSpan.Day => at.AddDays(1),
        ChunkSpan.Month => at.AddMonths(1),
        _ => at.AddYears(1),
    };

    private static DateTime Floor(DateTime at, int seconds)
    {
        var ticks = TimeSpan.FromSeconds(seconds).Ticks;
        return new DateTime(at.Ticks - at.Ticks % ticks, DateTimeKind.Utc);
    }

    /// <summary>Delete the chunks a tier no longer keeps. Retention is whole files, never a rewrite.</summary>
    public int Trim(DateTime nowUtc)
    {
        var gone = 0;
        foreach (var folder in Folders())
            foreach (var tier in Tiers)
            {
                var dir = Path.Combine(Root, folder, tier.Name);
                if (!Directory.Exists(dir)) continue;
                foreach (var file in Directory.GetFiles(dir, "*.rts"))
                {
                    var chunk = SeriesFile.Open(file);
                    if (chunk is null) continue;
                    var ends = Next(tier.Chunk, chunk.Start);
                    if (ends >= nowUtc.AddDays(-tier.KeepDays)) continue;
                    try { File.Delete(file); gone++; }
                    catch (IOException) { /* in use: the next sweep gets it */ }
                }
            }
        return gone;
    }
}
