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
