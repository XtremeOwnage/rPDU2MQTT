using System.Globalization;
using System.Text;
using System.Text.Json;
using rPDU2MQTT.Core.Flow;

namespace rPDU2MQTT.Integrations.Prometheus;

/// <summary>
/// Reading and writing Prometheus's own dialect: the PromQL a history read is expressed in, and the JSON
/// its API answers with — including the shapes that mean "no data".
///
/// <para>
/// This lives with the Prometheus integration rather than in Core because it is Prometheus's grammar and
/// nobody else's. A second history backend brings its own; it does not extend a shared parser, and Core
/// does not learn a third vendor's wire format to accommodate it. What everything outside this folder sees
/// is <see cref="IMeasurementHistory"/>.
/// </para>
/// <para>
/// Pure, so every one of those shapes is covered without a server.
/// </para>
/// </summary>
internal static class PrometheusWire
{
    /// <summary>
    /// The query that reads one value per node, whatever produced it.
    /// </summary>
    public static string NodeQuery(string metricName, IReadOnlyCollection<string> nodeIds)
        => $"max by (node) ({metricName}{{node=~\"{NodeMatcher(nodeIds)}\"}})";

    /// <summary>
    /// A Prometheus range answer: one series per node, each a list of [timestamp, value] pairs, folded onto
    /// the step boundaries the caller asked for.
    /// </summary>
    public static IReadOnlyList<IReadOnlyDictionary<string, double>> Range(string json, IReadOnlyList<long> stepsUnix)
    {
        var steps = stepsUnix.Count;
        var slots = new List<Dictionary<string, double>>(steps);
        for (var i = 0; i < steps; i++) slots.Add(new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase));
        if (steps == 0) return slots;

        // Which slot a sample belongs to.
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
    /// <summary>
    /// What Prometheus said about a query: its own <c>status</c> and, when it refused, the reason it gave.
    ///
    /// <para>
    /// A rejected query answers 400 with <c>{"status":"error","error":"…"}</c>, and reading only the HTTP
    /// code loses the half that says what to fix. This is what lets a probe report "unknown escape
    /// sequence" instead of a green tick over a backend that has refused every read for weeks.
    /// </para>
    /// </summary>
    public static (bool Ok, string? Error, int Series) Status(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            var status = root.TryGetProperty("status", out var st) ? st.GetString() : null;
            if (!string.Equals(status, "success", StringComparison.Ordinal))
            {
                var error = root.TryGetProperty("error", out var e) ? e.GetString() : null;
                return (false, error ?? status ?? "no status in the answer", 0);
            }

            var series = root.TryGetProperty("data", out var data)
                      && data.TryGetProperty("result", out var result)
                      && result.ValueKind == JsonValueKind.Array
                ? result.GetArrayLength() : 0;
            return (true, null, series);
        }
        catch (JsonException ex) { return (false, $"unreadable answer ({ex.Message})", 0); }
    }

    /// <summary>
    /// The single number an aggregate query answers with (<c>count(...)</c> has no <c>node</c> label, so
    /// <see cref="Instant"/> — which keys by node — finds nothing in it). 0 when there is none.
    /// </summary>
    public static double InstantScalar(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (!doc.RootElement.TryGetProperty("data", out var data)) return 0;
            if (!data.TryGetProperty("result", out var result) || result.ValueKind != JsonValueKind.Array) return 0;

            foreach (var series in result.EnumerateArray())
            {
                if (!series.TryGetProperty("value", out var pair) || pair.ValueKind != JsonValueKind.Array) continue;
                var parts = pair.EnumerateArray().ToList();
                if (parts.Count < 2) continue;
                var raw = parts[1].ValueKind == JsonValueKind.String ? parts[1].GetString() : parts[1].ToString();
                if (double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out var v) && double.IsFinite(v))
                    return v;
            }
            return 0;
        }
        catch (JsonException) { return 0; }
    }

    public static IReadOnlyDictionary<string, double> Instant(string json)
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

    /// <summary>Characters RE2 reads as pattern syntax. ':' and '#' are ordinary text and must be left alone.</summary>
    private const string RegexMeta = @"\.+*?()|[]{}^$";

    /// <summary>
    /// A Prometheus label matcher for the node ids asked about, so one query covers them all.
    /// </summary>
    /// <remarks>
    /// <para>
    /// This has to satisfy two grammars at once, and getting either wrong breaks the whole query rather
    /// than one node. PromQL reads the matcher as a double-quoted STRING first, and its escapes are Go's:
    /// <c>\.</c> and <c>\#</c> are not escapes at all, so a query carrying one is rejected outright —
    /// <c>parse error: unknown escape sequence</c>, an HTTP 400, and every node's history comes back empty.
    /// What survives the string is then read by RE2 as the pattern.
    /// </para>
    /// <para>
    /// So: escape only what RE2 treats as syntax, and emit each backslash doubled so one reaches the
    /// pattern. <c>.NET Regex.Escape</c> does neither — it escapes '#' (which RE2 does not need and PromQL
    /// rejects) and emits single backslashes — which is how every history read that included a return-lane
    /// id like <c>grid#in</c> failed silently for weeks.
    /// </para>
    /// </remarks>
    public static string NodeMatcher(IEnumerable<string> nodeIds)
        => string.Join('|', nodeIds.Select(Escape));

    private static string Escape(string id)
    {
        var sb = new StringBuilder(id.Length + 8);
        foreach (var c in id)
        {
            // A quote would end the string literal; the pattern is happy with a bare one.
            if (c == '"') { sb.Append("\\\""); continue; }
            if (RegexMeta.Contains(c)) sb.Append(@"\\");
            sb.Append(c);
        }
        return sb.ToString();
    }
}
