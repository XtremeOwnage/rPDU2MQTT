using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Helpers;
using Serilog;

namespace rPDU2MQTT.Integrations.Prometheus;

/// <summary>
/// Past flow values from the Prometheus that scrapes this bridge.
/// </summary>
public sealed class PrometheusFlowHistory(HttpClient http, Config cfg) : IMeasurementHistory
{
    public string Id => "prometheus";

    /// <summary>
    /// Reachable, and does a read actually work?
    ///
    /// <para>
    /// Readiness alone is not the question anyone is asking when they press "Test history backend". A server
    /// can be perfectly up and refuse every query this bridge sends — which is exactly what happened: the
    /// label matcher carried an escape PromQL rejects, every read came back empty for weeks, and the test
    /// button stayed green the whole time because <c>/-/ready</c> knew nothing about it.
    /// </para>
    /// <para>
    /// So the probe now sends the same query shape the reader sends, for a node id carrying the characters
    /// that make matchers fail (':' and '#'). It matches nothing on purpose: an empty result proves the
    /// grammar, and a refusal reports what the server said. Then it counts what is actually stored, because
    /// "reachable, holding nothing" and "reachable, holding a fortnight" are different answers.
    /// </para>
    /// </summary>
    public async Task<(bool Ok, string Detail)> ProbeAsync(CancellationToken ct)
    {
        var baseUrl = (cfg.History.PrometheusUrl ?? "").TrimEnd('/');
        if (baseUrl.Length == 0) return (false, "no PrometheusUrl set");
        try
        {
            // Its own readiness endpoint: it answers whether the server is up.
            var response = await http.GetAsync($"{baseUrl}/-/ready", ct);
            if (!response.IsSuccessStatusCode) return (false, $"{baseUrl} answered {(int)response.StatusCode}");

            var name = MetricsHelper.PrometheusFlowMetricName(Core.Flow.FlowGraphBuilder.DefaultMetric, cfg);

            // The reader's own query shape, against an id that exercises the punctuation real node ids carry.
            var matcher = await QueryAsync(baseUrl, PrometheusWire.NodeQuery(name, [ProbeNodeId]), ct);
            if (!matcher.Ok) return (false, $"{baseUrl} rejected the query this reads with: {matcher.Error}");

            // …and what it is holding, so "nothing stored yet" is not mistaken for "broken".
            var stored = await QueryAsync(baseUrl, $"count({name})", ct);
            var held = stored.Ok && stored.Series > 0 ? $"{stored.Count:0} flow series" : "no flow series stored yet";
            return (true, $"{baseUrl} · {held}");
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            // HttpClient reports its own timeout as a cancellation.
            return (false, $"{baseUrl}: no answer within {http.Timeout.TotalSeconds:0}s");
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return (false, $"{baseUrl}: {ex.Message}");
        }
    }

    /// <summary>A node id nothing will match, carrying the punctuation that makes a label matcher fail.</summary>
    private const string ProbeNodeId = "rpdu2mqtt:probe#in";

    /// <summary>Run one instant query and report whether Prometheus accepted it, and what came back.</summary>
    private async Task<(bool Ok, string? Error, int Series, double Count)> QueryAsync(string baseUrl, string query, CancellationToken ct)
    {
        var response = await http.GetAsync($"{baseUrl}/api/v1/query?query={Uri.EscapeDataString(query)}", ct);
        var body = await response.Content.ReadAsStringAsync(ct);
        var (ok, error, series) = PrometheusWire.Status(body);
        if (!ok) return (false, error, 0, 0);

        // count() answers as a single scalar-ish series; its value is the number we want to report.
        var value = PrometheusWire.InstantScalar(body);
        return (true, null, series, value);
    }

    /// <summary>
    /// The whole range in one request. Prometheus has an endpoint for exactly this question, and the
    /// alternative — an instant query per step — is what made a chart of anything finer than a day
    /// impractical.
    /// </summary>
    public async Task<IReadOnlyList<IReadOnlyDictionary<string, double>>> SeriesAsync(
        IReadOnlyCollection<string> nodeIds, string metric, IReadOnlyList<DateTime> steps, CancellationToken ct)
    {
        var empty = steps.Select(_ => (IReadOnlyDictionary<string, double>)new Dictionary<string, double>()).ToList();
        var baseUrl = (cfg.History.PrometheusUrl ?? "").TrimEnd('/');
        if (baseUrl.Length == 0 || nodeIds.Count == 0 || steps.Count == 0) return empty;

        var unix = steps.Select(s => new DateTimeOffset(DateTime.SpecifyKind(s, DateTimeKind.Utc)).ToUnixTimeSeconds()).ToList();
        // The step Prometheus is asked for has to be the one the caller wants back.
        var stride = steps.Count > 1 ? Math.Max(1, unix[1] - unix[0]) : 1;

        var name = MetricsHelper.PrometheusFlowMetricName(metric, cfg);
        var query = PrometheusWire.NodeQuery(name, nodeIds);
        var url = $"{baseUrl}/api/v1/query_range?query={Uri.EscapeDataString(query)}"
                + $"&start={unix[0]}&end={unix[^1]}&step={stride}s";

        try
        {
            var response = await http.GetAsync(url, ct);
            var body = await response.Content.ReadAsStringAsync(ct);
            if (!response.IsSuccessStatusCode)
            {
                Log.Warning($"Flow history: Prometheus answered {(int)response.StatusCode} for {name} over {steps.Count} step(s) — {Trim(body)}");
                return empty;
            }
            return PrometheusWire.Range(body, unix);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            Log.Warning($"Flow history: could not reach Prometheus at {baseUrl} ({ex.Message}).");
            return empty;
        }
    }

    public async Task<IReadOnlyDictionary<string, double>> ValuesAtAsync(
        IReadOnlyCollection<string> nodeIds, string metric, DateTime atUtc, CancellationToken ct)
    {
        var baseUrl = (cfg.History.PrometheusUrl ?? "").TrimEnd('/');
        if (baseUrl.Length == 0 || nodeIds.Count == 0) return new Dictionary<string, double>();

        // The same name the exporter writes, so the query cannot drift from what is stored.
        var name = MetricsHelper.PrometheusFlowMetricName(metric, cfg);
        var query = PrometheusWire.NodeQuery(name, nodeIds);
        var at = new DateTimeOffset(DateTime.SpecifyKind(atUtc, DateTimeKind.Utc)).ToUnixTimeSeconds();
        var url = $"{baseUrl}/api/v1/query?query={Uri.EscapeDataString(query)}&time={at}";

        try
        {
            var response = await http.GetAsync(url, ct);
            var body = await response.Content.ReadAsStringAsync(ct);
            if (!response.IsSuccessStatusCode)
            {
                Log.Warning($"Flow history: Prometheus answered {(int)response.StatusCode} for {name} at {atUtc:u} — {Trim(body)}");
                return new Dictionary<string, double>();
            }
            return PrometheusWire.Instant(body);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            Log.Warning($"Flow history: could not reach Prometheus at {baseUrl} ({ex.Message}).");
            return new Dictionary<string, double>();
        }
    }
    /// <summary>
    /// What the backend said, short enough for a log line. A rejected query answers with the reason —
    /// "unknown escape sequence", a bad metric name — and dropping it left "no data" as the only visible
    /// symptom of a query that never had a chance.
    /// </summary>
    private static string Trim(string body)
        => body.Length <= 300 ? body.Replace('\n', ' ') : body[..300].Replace('\n', ' ') + "…";
}
