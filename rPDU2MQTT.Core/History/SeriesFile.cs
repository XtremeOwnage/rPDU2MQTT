using System.Buffers.Binary;

namespace rPDU2MQTT.Core.History;

/// <summary>
/// One chunk of one series on disk: a header, then a reading per slot at a fixed interval (#502).
///
/// <para>
/// There is no index and nothing to corrupt beyond the readings themselves. A slot is found by arithmetic —
/// <c>(when - start) / interval</c> — so a read is one seek, whatever the file holds, and a chunk that was
/// never written past slot n simply ends there.
/// </para>
/// <para>
/// A slot nobody wrote is <b>NaN</b>, which is the same thing the rest of the bridge means by "no reading":
/// unknown is never stored as a zero, and a gap survives every read and roll-up unchanged.
/// </para>
/// </summary>
public sealed class SeriesFile
{
    /// <summary>What a reader checks before believing anything else in the file.</summary>
    public static ReadOnlySpan<byte> Magic => "RPDU_TS1"u8;

    public const int HeaderBytes = 32;
    public const int SlotBytes = 8;

    public string Path { get; }
    public int IntervalSeconds { get; }
    public DateTime Start { get; }

    private SeriesFile(string path, int intervalSeconds, DateTime start)
    {
        Path = path;
        IntervalSeconds = intervalSeconds;
        Start = start;
    }

    /// <summary>The slot a moment falls in, or -1 when it is before this chunk began.</summary>
    public long SlotOf(DateTime whenUtc)
    {
        var seconds = (long)Math.Floor((DateTime.SpecifyKind(whenUtc, DateTimeKind.Utc) - Start).TotalSeconds);
        return seconds < 0 ? -1 : seconds / IntervalSeconds;
    }

    /// <summary>The moment a slot begins.</summary>
    public DateTime TimeOf(long slot) => Start.AddSeconds(slot * (double)IntervalSeconds);

    /// <summary>Open a chunk, writing its header if the file is new. The directory is created as needed.</summary>
    public static SeriesFile Create(string path, int intervalSeconds, DateTime startUtc)
    {
        if (intervalSeconds <= 0) throw new ArgumentOutOfRangeException(nameof(intervalSeconds));
        var start = DateTime.SpecifyKind(startUtc, DateTimeKind.Utc);
        var dir = System.IO.Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

        using var stream = new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.ReadWrite);
        if (stream.Length >= HeaderBytes) return Open(path) ?? throw new InvalidDataException($"{path} is not a series file.");

        Span<byte> header = stackalloc byte[HeaderBytes];
        header.Clear();
        Magic.CopyTo(header);
        BinaryPrimitives.WriteInt32LittleEndian(header[8..], 1);                                  // version
        BinaryPrimitives.WriteInt32LittleEndian(header[12..], intervalSeconds);
        BinaryPrimitives.WriteInt64LittleEndian(header[16..], new DateTimeOffset(start).ToUnixTimeSeconds());
        BinaryPrimitives.WriteInt32LittleEndian(header[24..], SlotBytes);                          // one float64 per slot
        stream.Position = 0;
        stream.Write(header);
        stream.Flush();
        return new SeriesFile(path, intervalSeconds, start);
    }

    /// <summary>Read a chunk's header, or null when the file is missing, too short, or not one of ours.</summary>
    public static SeriesFile? Open(string path)
    {
        try
        {
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            if (stream.Length < HeaderBytes) return null;
            Span<byte> header = stackalloc byte[HeaderBytes];
            stream.ReadExactly(header);
            if (!header[..8].SequenceEqual(Magic)) return null;
            var interval = BinaryPrimitives.ReadInt32LittleEndian(header[12..]);
            if (interval <= 0) return null;
            var start = DateTimeOffset.FromUnixTimeSeconds(BinaryPrimitives.ReadInt64LittleEndian(header[16..])).UtcDateTime;
            return new SeriesFile(path, interval, start);
        }
        catch (IOException) { return null; }
        catch (UnauthorizedAccessException) { return null; }
    }

    /// <summary>How many slots the file holds. A half-written slot at the end is not one of them.</summary>
    public long Slots()
    {
        try
        {
            var length = new FileInfo(Path).Length;
            return length <= HeaderBytes ? 0 : (length - HeaderBytes) / SlotBytes;
        }
        catch (IOException) { return 0; }
    }

    /// <summary>Write one reading. Slots skipped over are left as "no reading" rather than carried or zeroed.</summary>
    public void Write(long slot, double value)
    {
        if (slot < 0) return;
        using var stream = new FileStream(Path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.ReadWrite);
        var want = HeaderBytes + slot * SlotBytes;
        if (stream.Length < want) Fill(stream, stream.Length < HeaderBytes ? HeaderBytes : stream.Length, want);
        stream.Position = want;
        Span<byte> slotBytes = stackalloc byte[SlotBytes];
        BinaryPrimitives.WriteDoubleLittleEndian(slotBytes, value);
        stream.Write(slotBytes);
        stream.Flush();
    }

    /// <summary>Write several readings at once — one open, one flush, which is what a sweep of nodes costs.</summary>
    public void WriteMany(IEnumerable<(long Slot, double Value)> readings)
    {
        using var stream = new FileStream(Path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.ReadWrite);
        Span<byte> slotBytes = stackalloc byte[SlotBytes];
        foreach (var (slot, value) in readings.OrderBy(r => r.Slot))
        {
            if (slot < 0) continue;
            var want = HeaderBytes + slot * SlotBytes;
            if (stream.Length < want) Fill(stream, Math.Max(stream.Length, HeaderBytes), want);
            stream.Position = want;
            BinaryPrimitives.WriteDoubleLittleEndian(slotBytes, value);
            stream.Write(slotBytes);
        }
        stream.Flush();
    }

    /// <summary>`count` readings from `slot`, with NaN wherever nothing was written — including past the end.</summary>
    public double[] Read(long slot, int count)
    {
        var values = new double[Math.Max(0, count)];
        Array.Fill(values, double.NaN);
        if (count <= 0 || slot < 0) return values;

        try
        {
            using var stream = new FileStream(Path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            var slots = stream.Length <= HeaderBytes ? 0 : (stream.Length - HeaderBytes) / SlotBytes;
            if (slot >= slots) return values;

            var take = (int)Math.Min(count, slots - slot);
            var buffer = new byte[take * SlotBytes];
            stream.Position = HeaderBytes + slot * SlotBytes;
            stream.ReadExactly(buffer, 0, buffer.Length);
            for (var i = 0; i < take; i++)
                values[i] = BinaryPrimitives.ReadDoubleLittleEndian(buffer.AsSpan(i * SlotBytes));
        }
        catch (IOException) { /* a file being written to answers what it can */ }
        catch (UnauthorizedAccessException) { }
        return values;
    }

    /// <summary>The last reading at or before `slot`, looking back at most `lookBack` slots. NaN when there is none.</summary>
    public double At(long slot, int lookBack)
    {
        if (slot < 0) return double.NaN;
        var from = Math.Max(0, slot - Math.Max(0, lookBack));
        var window = Read(from, (int)(slot - from + 1));
        for (var i = window.Length - 1; i >= 0; i--)
            if (!double.IsNaN(window[i])) return window[i];
        return double.NaN;
    }

    /// <summary>Grow a file with "no reading" rather than zeros: the space between two samples is unknown.</summary>
    private static void Fill(FileStream stream, long from, long to)
    {
        Span<byte> nan = stackalloc byte[SlotBytes];
        BinaryPrimitives.WriteDoubleLittleEndian(nan, double.NaN);
        stream.Position = from;
        for (var at = from; at < to; at += SlotBytes) stream.Write(nan);
    }
}
