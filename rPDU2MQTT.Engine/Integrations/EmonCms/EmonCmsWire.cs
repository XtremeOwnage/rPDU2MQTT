using System.Globalization;
using System.Text.Json;

namespace rPDU2MQTT.Integrations.EmonCms;

/// <summary>
/// Reading EmonCMS's own answers: the feed list a lookup is resolved against, and the point series a
/// history read pulls values out of — including the shapes that mean "no data".
///
/// <para>
/// This lives with the EmonCMS integration rather than in Core because it is EmonCMS's format and nobody
/// else's. What everything outside this folder sees is <see cref="IMeasurementHistory"/>.
/// </para>
/// <para>
/// Pure, so every one of those shapes is covered without a server.
/// </para>
/// </summary>
internal static class EmonCmsWire
{
    /// <summary>
    /// EmonCMS <c>/feed/list.json</c> in full: every feed with its current value and timestamp.
    ///
    /// <para>
    /// This one call is what makes reading feeds cost a single request no matter how many are bound. The
    /// per-feed endpoints (<c>feed/value.json</c>, <c>feed/timevalue.json</c>) would be a request each, and
    /// <c>feed/fetch.json</c> answers with bare values and no timestamps — with no timestamp there is no way
    /// to tell a feed that stopped an hour ago from one being written right now, and the whole point of a
    /// staleness rule is to be able to.
    /// </para>
    /// </summary>
    public static IReadOnlyList<EmonCmsFeed> FeedStates(string json)
    {
        var found = new List<EmonCmsFeed>();
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.ValueKind != JsonValueKind.Array) return found;
            foreach (var feed in doc.RootElement.EnumerateArray())
            {
                if (feed.ValueKind != JsonValueKind.Object) continue;
                var id = Text(feed, "id");
                var name = Text(feed, "name");
                if (string.IsNullOrEmpty(id) || string.IsNullOrEmpty(name)) continue;

                found.Add(new EmonCmsFeed(id, name, Text(feed, "tag"), Text(feed, "unit"),
                    Number(feed, "value"),
                    Number(feed, "time") is { } t and >= 0 ? DateTimeOffset.FromUnixTimeSeconds((long)t).UtcDateTime : null));
            }
        }
        catch (JsonException) { /* an unreadable list means no feeds, not a crash */ }
        return found;
    }

    /// <summary>A string property, however EmonCMS chose to type it. Empty when absent or null.</summary>
    private static string Text(JsonElement obj, string name)
        => obj.TryGetProperty(name, out var v) && v.ValueKind is not (JsonValueKind.Null or JsonValueKind.Undefined)
            ? (v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : v.ToString())
            : "";

    /// <summary>A numeric property, quoted or not. Null when absent, null, or not a finite number.</summary>
    private static double? Number(JsonElement obj, string name)
    {
        if (!obj.TryGetProperty(name, out var v) || v.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
            return null;
        var raw = v.ValueKind == JsonValueKind.String ? v.GetString() : v.ToString();
        return double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out var d) && double.IsFinite(d)
            ? d : null;
    }

    /// <summary>EmonCMS <c>/feed/list.json</c>: feed name -> id.</summary>
    public static IReadOnlyDictionary<string, string> Feeds(string json)
    {
        var found = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.ValueKind != JsonValueKind.Array) return found;
            foreach (var feed in doc.RootElement.EnumerateArray())
            {
                var name = feed.TryGetProperty("name", out var n) ? n.GetString() : null;
                var id = feed.TryGetProperty("id", out var i)
                    ? (i.ValueKind == JsonValueKind.String ? i.GetString() : i.ToString())
                    : null;
                if (!string.IsNullOrEmpty(name) && !string.IsNullOrEmpty(id)) found[name!] = id!;
            }
        }
        catch (JsonException) { /* an unreadable list means no feeds, not a crash */ }
        return found;
    }

    /// <summary>
    /// EmonCMS <c>/feed/data.json</c>: <c>[[msTimestamp, value], …]</c>. Returns the last point at or before
    /// <paramref name="atUnixMs"/>, or null when the window holds none.
    /// </summary>
    /// <remarks>
    /// A null value is a gap EmonCMS records where the feed had no data, and it appears in the array
    /// alongside real points. Taking the last element regardless would report a gap as a reading.
    /// </remarks>
    /// <summary>
    /// One value per requested instant, from a single range payload.
    ///
    /// <para>
    /// A feed read is <c>[[unix_ms, value], …]</c> ascending. Reading a whole window once and walking it
    /// against the instants replaces a request per instant: a day of five-minute steps is 289 of them, and
    /// EmonCMS was answering that as 289 requests per node.
    /// </para>
    /// <para>
    /// Each instant takes the last point at or before it, which is the same rule as
    /// <see cref="PointAt"/> — a reading holds until the next one. Null where no point precedes the instant,
    /// because a feed that starts mid-window has nothing to say about the part before it.
    /// </para>
    /// </summary>
    public static double?[] Series(string json, IReadOnlyList<long> atUnixMs)
    {
        var answers = new double?[atUnixMs.Count];
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.ValueKind != JsonValueKind.Array) return answers;

            // The payload is ascending, but a feed is not a contract: sorted here so a walk is safe.
            var points = new List<(long At, double Value)>();
            foreach (var point in doc.RootElement.EnumerateArray())
            {
                if (point.ValueKind != JsonValueKind.Array) continue;
                var parts = point.EnumerateArray().ToList();
                if (parts.Count < 2) continue;
                if (!parts[0].TryGetInt64(out var ts)) continue;
                if (parts[1].ValueKind is JsonValueKind.Null or JsonValueKind.Undefined) continue;

                var raw = parts[1].ValueKind == JsonValueKind.String ? parts[1].GetString() : parts[1].ToString();
                if (!double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out var v) || !double.IsFinite(v)) continue;
                points.Add((ts, v));
            }
            points.Sort((a, b) => a.At.CompareTo(b.At));
            if (points.Count == 0) return answers;

            // The instants are asked for in order too, so both are walked once rather than searched per step.
            var order = Enumerable.Range(0, atUnixMs.Count).OrderBy(i => atUnixMs[i]).ToList();
            var cursor = 0;
            double? held = null;
            foreach (var i in order)
            {
                while (cursor < points.Count && points[cursor].At <= atUnixMs[i]) held = points[cursor++].Value;
                answers[i] = held;
            }
            return answers;
        }
        catch (JsonException) { return answers; }
    }

    public static double? PointAt(string json, long atUnixMs)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.ValueKind != JsonValueKind.Array) return null;

            double? best = null;
            long bestAt = long.MinValue;
            foreach (var point in doc.RootElement.EnumerateArray())
            {
                if (point.ValueKind != JsonValueKind.Array) continue;
                var parts = point.EnumerateArray().ToList();
                if (parts.Count < 2) continue;
                if (!parts[0].TryGetInt64(out var ts) || ts > atUnixMs) continue;
                if (parts[1].ValueKind is JsonValueKind.Null or JsonValueKind.Undefined) continue;

                var raw = parts[1].ValueKind == JsonValueKind.String ? parts[1].GetString() : parts[1].ToString();
                if (!double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out var v) || !double.IsFinite(v)) continue;

                if (ts >= bestAt) { bestAt = ts; best = v; }
            }
            return best;
        }
        catch (JsonException) { return null; }
    }

}
