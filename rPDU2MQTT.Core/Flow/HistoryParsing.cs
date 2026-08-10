using System.Globalization;
using System.Text.Json;

namespace rPDU2MQTT.Core.Flow;

/// <summary>
/// Reading a backend's answer into node values. Pure, so the shapes each API returns — including the ones
/// that mean "no data" — are covered without a server.
/// </summary>
public static class HistoryParsing
{
    /// <summary>
    /// The query that reads one value per node, whatever produced it.
    ///
    /// </summary>
    public static string NodeQuery(string metricName, IReadOnlyCollection<string> nodeIds)
        => $"max by (node) ({metricName}{{node=~\"{NodeMatcher(nodeIds)}\"}})";

    /// <summary>
    /// A Prometheus range answer: one series per node, each a list of [timestamp, value] pairs, folded onto
    /// the step boundaries the caller asked for.
    ///
    /// </summary>
    public static IReadOnlyList<IReadOnlyDictionary<string, double>> PrometheusRange(string json, IReadOnlyList<long> stepsUnix)
    {
        var steps = stepsUnix.Count;
        var slots = new List<Dictionary<string, double>>(steps);
        for (var i = 0; i < steps; i++) slots.Add(new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase));
        if (steps == 0) return slots;

        // Which slot a sample belongs to. Prometheus aligns to the step it was given, but a server clock or
        var index = new Dictionary<long, int>();
        for (var i = 0; i < steps; i++) index[stepsUnix[i]] = i;
        var first = stepsUnix[0];
        var stride = steps > 1 ? stepsUnix[1] - stepsUnix[0] : 1;

        try
        {
            using var doc = JsonDocument.Parse(json);
            if (!doc.RootElement.TryGetProperty("data", out var data)) return slots;
            if (!data.TryGetProperty("result", out var result) || result.ValueKind != JsonValueKind.Array) return slots;

            foreach (var seriesEl in result.EnumerateArray())
            {
                if (!seriesEl.TryGetProperty("metric", out var m) || !m.TryGetProperty("node", out var nodeEl)) continue;
                var node = nodeEl.GetString();
                if (string.IsNullOrEmpty(node)) continue;
                if (!seriesEl.TryGetProperty("values", out var values) || values.ValueKind != JsonValueKind.Array) continue;

                foreach (var pair in values.EnumerateArray())
                {
                    if (pair.ValueKind != JsonValueKind.Array || pair.GetArrayLength() < 2) continue;
                    var at = (long)pair[0].GetDouble();
                    var raw = pair[1].GetString();
                    if (!double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out var v) || !double.IsFinite(v)) continue;

                    if (!index.TryGetValue(at, out var slot))
                    {
                        if (stride <= 0) continue;
                        slot = (int)Math.Round((double)(at - first) / stride);
                        if (slot < 0 || slot >= steps) continue;
                    }
                    slots[slot][node] = v;
                }
            }
        }
        catch (JsonException) { /* an unparseable answer is no history, not a crash */ }
        return slots;
    }

    /// <summary>
    /// Prometheus instant-query result: <c>data.result[]</c>, each with <c>metric.node</c> and a
    /// <c>[timestamp, "value"]</c> pair.
    /// </summary>
    /// <remarks>
    /// A non-finite sample is dropped. Prometheus renders staleness and division results as "NaN" and
    /// "+Inf" in the same field a number appears in, and either would enter the roll-up as a figure.
    /// </remarks>
    public static IReadOnlyDictionary<string, double> PrometheusInstant(string json)
    {
        var found = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);
        JsonDocument doc;
        try { doc = JsonDocument.Parse(json); }
        catch (JsonException) { return found; }

        using (doc)
        {
            if (!doc.RootElement.TryGetProperty("data", out var data)) return found;
            if (!data.TryGetProperty("result", out var result) || result.ValueKind != JsonValueKind.Array) return found;

            foreach (var series in result.EnumerateArray())
            {
                if (!series.TryGetProperty("metric", out var labels)) continue;
                if (!labels.TryGetProperty("node", out var node)) continue;
                var id = node.GetString();
                if (string.IsNullOrEmpty(id)) continue;

                if (!series.TryGetProperty("value", out var pair) || pair.ValueKind != JsonValueKind.Array) continue;
                var parts = pair.EnumerateArray().ToList();
                if (parts.Count < 2) continue;

                var raw = parts[1].ValueKind == JsonValueKind.String ? parts[1].GetString() : parts[1].ToString();
                if (double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out var v) && double.IsFinite(v))
                    found[id] = v;
            }
        }
        return found;
    }

    /// <summary>EmonCMS <c>/feed/list.json</c>: feed name -> id.</summary>
    public static IReadOnlyDictionary<string, string> EmonCmsFeeds(string json)
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
    public static double? EmonCmsPointAt(string json, long atUnixMs)
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

    /// <summary>
    /// A Prometheus label matcher for the node ids asked about, so one query covers them all.
    /// </summary>
    /// <remarks>
    /// Ids are regex-escaped: an outlet id is <c>outlet:pdu_1:4</c> and a synthetic one carries '#', and an
    /// unescaped '.' or '|' in an id would silently widen the match to other nodes.
    /// </remarks>
    public static string NodeMatcher(IEnumerable<string> nodeIds)
        => string.Join('|', nodeIds.Select(System.Text.RegularExpressions.Regex.Escape));
}
