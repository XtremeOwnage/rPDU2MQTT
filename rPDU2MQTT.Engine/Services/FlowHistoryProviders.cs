using System.Globalization;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Helpers;
using Serilog;

namespace rPDU2MQTT.Services;

/// <summary>
/// Past flow values from the Prometheus that scrapes this bridge.
///
/// </summary>
public sealed class PrometheusFlowHistory(HttpClient http, Config cfg) : IFlowHistory
{
    public string Id => "prometheus";

    public async Task<(bool Ok, string Detail)> ProbeAsync(CancellationToken ct)
    {
        var baseUrl = (cfg.History.PrometheusUrl ?? "").TrimEnd('/');
        if (baseUrl.Length == 0) return (false, "no PrometheusUrl set");
        try
        {
            // Its own readiness endpoint: cheap, and it answers whether the server is up rather than
            var response = await http.GetAsync($"{baseUrl}/-/ready", ct);
            return response.IsSuccessStatusCode
                ? (true, baseUrl)
                : (false, $"{baseUrl} answered {(int)response.StatusCode}");
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            // HttpClient reports its own timeout as a cancellation. Passed on as-is it reaches the GUI as
            return (false, $"{baseUrl}: no answer within {http.Timeout.TotalSeconds:0}s");
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return (false, $"{baseUrl}: {ex.Message}");
        }
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
        // The step Prometheus is asked for has to be the one the caller wants back, or the samples land
        var stride = steps.Count > 1 ? Math.Max(1, unix[1] - unix[0]) : 1;

        var name = MetricsHelper.PrometheusMetricName($"flow_{metric}", "", "", "", cfg);
        var query = HistoryParsing.NodeQuery(name, nodeIds);
        var url = $"{baseUrl}/api/v1/query_range?query={Uri.EscapeDataString(query)}"
                + $"&start={unix[0]}&end={unix[^1]}&step={stride}s";

        try
        {
            var response = await http.GetAsync(url, ct);
            var body = await response.Content.ReadAsStringAsync(ct);
            if (!response.IsSuccessStatusCode)
            {
                Log.Warning($"Flow history: Prometheus answered {(int)response.StatusCode} for {name} over {steps.Count} step(s).");
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
        var name = MetricsHelper.PrometheusMetricName($"flow_{metric}", "", "", "", cfg);
        var query = HistoryParsing.NodeQuery(name, nodeIds);
        var at = new DateTimeOffset(DateTime.SpecifyKind(atUtc, DateTimeKind.Utc)).ToUnixTimeSeconds();
        var url = $"{baseUrl}/api/v1/query?query={Uri.EscapeDataString(query)}&time={at}";

        try
        {
            var response = await http.GetAsync(url, ct);
            var body = await response.Content.ReadAsStringAsync(ct);
            if (!response.IsSuccessStatusCode)
            {
                Log.Warning($"Flow history: Prometheus answered {(int)response.StatusCode} for {name} at {atUtc:u}.");
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
}

/// <summary>
/// Past flow values from EmonCMS feeds.
///
/// </summary>
public sealed class EmonCmsFlowHistory(HttpClient http, Config cfg) : IFlowHistory
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
        // Reachable but with no feeds is still a working backend with nothing to show, and saying so is
        return list.Count > 0 ? (true, $"{baseUrl} · {list.Count} feed(s)") : (false, $"{baseUrl}: no feeds readable");
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
            // Feed naming mirrors the export's input naming: "<node>_<metric>", then the bare node.
            if (!list.TryGetValue($"{node}_{metric}", out var id) && !list.TryGetValue(node, out id)) continue;
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
///
/// </summary>
public sealed class FlowHistoryRouter(HttpClient http, Config cfg) : IFlowHistory
{
    private readonly PrometheusFlowHistory prometheus = new(http, cfg);
    private readonly EmonCmsFlowHistory emoncms = new(http, cfg);

    private IFlowHistory Current =>
        string.Equals(cfg.History.Provider, "emoncms", StringComparison.OrdinalIgnoreCase) ? emoncms : prometheus;

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
