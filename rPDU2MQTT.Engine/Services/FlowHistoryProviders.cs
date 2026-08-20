using System.Globalization;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Helpers;
using Serilog;

namespace rPDU2MQTT.Services;

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
            var matcher = await QueryAsync(baseUrl, HistoryParsing.NodeQuery(name, [ProbeNodeId]), ct);
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
        var (ok, error, series) = HistoryParsing.PrometheusStatus(body);
        if (!ok) return (false, error, 0, 0);

        // count() answers as a single scalar-ish series; its value is the number we want to report.
        var value = HistoryParsing.PrometheusInstantScalar(body);
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
        var query = HistoryParsing.NodeQuery(name, nodeIds);
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
            return HistoryParsing.PrometheusRange(body, unix);
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
        var query = HistoryParsing.NodeQuery(name, nodeIds);
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
            return HistoryParsing.PrometheusInstant(body);
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

/// <summary>
/// Past flow values from EmonCMS feeds.
/// </summary>
public sealed class EmonCmsFlowHistory(HttpClient http, Config cfg) : IMeasurementHistory
{
    private IReadOnlyDictionary<string, string>? feeds;
    private DateTime feedsAt;

    public string Id => "emoncms";

    public async Task<(bool Ok, string Detail)> ProbeAsync(CancellationToken ct)
    {
        var baseUrl = (cfg.EmonCMS.Url ?? "").TrimEnd('/');
        if (baseUrl.Length == 0) return (false, "no EmonCMS URL set");
        IReadOnlyDictionary<string, string> list;
        try { list = await FeedsAsync(baseUrl, cfg.EmonCMS.ApiKey ?? "", ct); }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            return (false, $"{baseUrl}: no answer within {http.Timeout.TotalSeconds:0}s");
        }
        catch (Exception ex) { return (false, $"{baseUrl}: {ex.Message}"); }
        // Reachable but with no feeds is still a working backend with nothing to show.
        if (list.Count == 0) return (false, $"{baseUrl}: no feeds readable");

        // A shelf full of feeds proves nothing if none of them is named the way the READER looks them up:
        // the lookup key comes from FlowInputNameTemplate, so changing that template leaves every feed in
        // place and every read empty. Name a node that would be asked for and say whether it is there.
        var wanted = cfg.EnergyFlow.Nodes.Select(n => n.Id).FirstOrDefault(id => !string.IsNullOrWhiteSpace(id));
        if (wanted is null) return (true, $"{baseUrl} · {list.Count} feed(s)");

        var key = MetricsHelper.EmonCmsFlowInputName(wanted, wanted, "", Core.Flow.FlowGraphBuilder.DefaultMetric, cfg);
        var matched = list.ContainsKey(key) || list.ContainsKey($"{wanted}_{Core.Flow.FlowGraphBuilder.DefaultMetric}") || list.ContainsKey(wanted);
        return (true, matched
            ? $"{baseUrl} · {list.Count} feed(s), '{key}' among them"
            : $"{baseUrl} · {list.Count} feed(s), but none named '{key}' — a read for '{wanted}' finds nothing");
    }

    public async Task<IReadOnlyDictionary<string, double>> ValuesAtAsync(
        IReadOnlyCollection<string> nodeIds, string metric, DateTime atUtc, CancellationToken ct)
    {
        var found = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);
        var baseUrl = (cfg.EmonCMS.Url ?? "").TrimEnd('/');
        var key = cfg.EmonCMS.ApiKey ?? "";
        if (baseUrl.Length == 0 || nodeIds.Count == 0) return found;

        var list = await FeedsAsync(baseUrl, key, ct);
        if (list.Count == 0) return found;

        var at = new DateTimeOffset(DateTime.SpecifyKind(atUtc, DateTimeKind.Utc)).ToUnixTimeMilliseconds();
        var window = Math.Max(1, cfg.History.ToleranceSeconds) * 1000L;

        foreach (var node in nodeIds)
        {
            // The same key the export writes its feed under, then the older bare-node fallback.
            var wanted = MetricsHelper.EmonCmsFlowInputName(node, node, "", metric, cfg);
            if (!list.TryGetValue(wanted, out var id)
                && !list.TryGetValue($"{node}_{metric}", out id)
                && !list.TryGetValue(node, out id)) continue;
            var url = $"{baseUrl}/feed/data.json?id={Uri.EscapeDataString(id)}&start={at - window}&end={at + window}"
                    + $"&interval={Math.Max(1, cfg.History.ToleranceSeconds)}&apikey={Uri.EscapeDataString(key)}";
            try
            {
                var response = await http.GetAsync(url, ct);
                if (!response.IsSuccessStatusCode) continue;
                if (HistoryParsing.EmonCmsPointAt(await response.Content.ReadAsStringAsync(ct), at) is { } v)
                    found[node] = v;
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                Log.Debug($"Flow history: EmonCMS feed {id} for '{node}' — {ex.Message}");
            }
        }
        return found;
    }

    /// <summary>The feed list, re-read every few minutes: feeds are created rarely, and once per node per view is a lot of calls.</summary>
    private async Task<IReadOnlyDictionary<string, string>> FeedsAsync(string baseUrl, string key, CancellationToken ct)
    {
        if (feeds is not null && DateTime.UtcNow - feedsAt < TimeSpan.FromMinutes(5)) return feeds;
        try
        {
            var response = await http.GetAsync($"{baseUrl}/feed/list.json?apikey={Uri.EscapeDataString(key)}", ct);
            if (!response.IsSuccessStatusCode)
            {
                Log.Warning($"Flow history: EmonCMS answered {(int)response.StatusCode} listing feeds.");
                return feeds ?? new Dictionary<string, string>();
            }
            feeds = HistoryParsing.EmonCmsFeeds(await response.Content.ReadAsStringAsync(ct));
            feedsAt = DateTime.UtcNow;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            Log.Warning($"Flow history: could not list EmonCMS feeds ({ex.Message}).");
        }
        return feeds ?? new Dictionary<string, string>();
    }
}

/// <summary>
/// Chooses the backend per call from the live configuration.
/// </summary>
public sealed class FlowHistoryRouter(HttpClient http, Config cfg) : IMeasurementHistory
{
    private readonly PrometheusFlowHistory prometheus = new(http, cfg);
    private readonly EmonCmsFlowHistory emoncms = new(http, cfg);
    private readonly Integrations.HomeAssistant.HomeAssistantHistory homeAssistant = new(http, cfg);

    // Chosen by id from live config, so adding a backend is one more line here and nothing else — the
    // property that made IMeasurementHistory the template the rest of the contracts were copied from.
    private IMeasurementHistory Current => cfg.History.Provider?.ToLowerInvariant() switch
    {
        "emoncms" => emoncms,
        "homeassistant" => homeAssistant,
        _ => prometheus,
    };

    public string Id => Current.Id;

    public Task<IReadOnlyDictionary<string, double>> ValuesAtAsync(
        IReadOnlyCollection<string> nodeIds, string metric, DateTime atUtc, CancellationToken ct)
        => cfg.History.Enabled
            ? Current.ValuesAtAsync(nodeIds, metric, atUtc, ct)
            : Task.FromResult<IReadOnlyDictionary<string, double>>(new Dictionary<string, double>());

    public Task<(bool Ok, string Detail)> ProbeAsync(CancellationToken ct)
        => cfg.History.Enabled ? Current.ProbeAsync(ct) : Task.FromResult((false, "history is turned off"));

    public Task<IReadOnlyList<IReadOnlyDictionary<string, double>>> SeriesAsync(
        IReadOnlyCollection<string> nodeIds, string metric, IReadOnlyList<DateTime> steps, CancellationToken ct)
        => Current.SeriesAsync(nodeIds, metric, steps, ct);
}
