using System.Collections.Concurrent;
using System.Globalization;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Helpers;
using Serilog;

namespace rPDU2MQTT.Integrations.EmonCms;

/// <summary>
/// Past flow values from EmonCMS feeds.
/// </summary>
public sealed class EmonCmsFlowHistory(HttpClient http, Config cfg) : IMeasurementHistory
{
    private IReadOnlyDictionary<string, string>? feeds;
    private DateTime feedsAt;

    /// <summary>
    /// How many feeds are read at once. EmonCMS answers one feed per request — there is no endpoint that
    /// takes a set — so a hierarchy of fifty nodes is fifty round trips, and one after another that is
    /// seconds of waiting. Several at a time turns it into a fraction of that without burying a backend
    /// whose feeds are rows in MySQL.
    /// </summary>
    private const int AtOnce = 8;

    /// <summary>Read the feeds of `ids` together, `AtOnce` at a time, and give each one's answer to `take`.</summary>
    private async Task ReadEachAsync<T>(IEnumerable<T> ids, Func<T, string> urlOf, Action<T, string> take, CancellationToken ct)
    {
        var answers = new ConcurrentBag<(T Id, string Body)>();
        await Parallel.ForEachAsync(ids, new ParallelOptions { MaxDegreeOfParallelism = AtOnce, CancellationToken = ct }, async (id, token) =>
        {
            try
            {
                var response = await http.GetAsync(urlOf(id), token);
                if (!response.IsSuccessStatusCode) return;
                answers.Add((id, await response.Content.ReadAsStringAsync(token)));
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                Log.Debug($"Flow history: EmonCMS read for '{id}' — {ex.Message}");
            }
        });
        // Parsed on one thread: what the readers share is the answers, not the dictionaries they fill.
        foreach (var (id, body) in answers) take(id, body);
    }

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

    /// <summary>
    /// The whole window in one read per feed, rather than the interface's default of one read per instant.
    ///
    /// <para>
    /// That default calls <see cref="ValuesAtAsync"/> once per step, and this reader makes a request per
    /// node, so a day of five-minute steps on thirty nodes was 8,670 sequential requests. The Trends page
    /// caps a series build at 60 seconds, so what the operator saw was not a slow chart: it was no history
    /// at all, on a backend that had every reading asked for.
    /// </para>
    /// <para>
    /// EmonCMS answers a range from the same endpoint — start, end and an interval — so the whole window
    /// costs one request per node.
    /// </para>
    /// </summary>
    public async Task<IReadOnlyList<IReadOnlyDictionary<string, double>>> SeriesAsync(
        IReadOnlyCollection<string> nodeIds, string metric, IReadOnlyList<DateTime> steps, CancellationToken ct)
    {
        var empty = steps.Select(_ => (IReadOnlyDictionary<string, double>)new Dictionary<string, double>()).ToList();
        var baseUrl = (cfg.EmonCMS.Url ?? "").TrimEnd('/');
        var key = cfg.EmonCMS.ApiKey ?? "";
        if (baseUrl.Length == 0 || nodeIds.Count == 0 || steps.Count == 0) return empty;

        var list = await FeedsAsync(baseUrl, key, ct);
        if (list.Count == 0) return empty;

        var at = steps.Select(s => new DateTimeOffset(DateTime.SpecifyKind(s, DateTimeKind.Utc)).ToUnixTimeMilliseconds()).ToList();
        var start = at.Min();
        var end = at.Max();
        // A point per step at most: asking for a finer interval than the steps only moves more of the feed
        // across the wire to be thrown away here.
        var interval = steps.Count > 1
            ? Math.Max(1, (int)Math.Round((end - start) / 1000.0 / (steps.Count - 1)))
            : Math.Max(1, cfg.History.ToleranceSeconds);
        // A step takes the last point at or before it, so the read starts one interval early — otherwise
        // the first step of every window is empty for want of a point that exists just outside it.
        var from = start - (long)interval * 1000L;

        var perStep = steps.Select(_ => new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase)).ToList();
        var wanted = nodeIds
            .Select(node => (Node: node, Feed: FeedFor(list, node, metric)))
            .Where(x => x.Feed is not null)
            .ToList();

        await ReadEachAsync(wanted,
            x => $"{baseUrl}/feed/data.json?id={Uri.EscapeDataString(x.Feed!)}&start={from}&end={end}"
               + $"&interval={interval}&apikey={Uri.EscapeDataString(key)}",
            (x, body) =>
            {
                var values = EmonCmsWire.Series(body, at);
                for (var i = 0; i < values.Length; i++)
                    if (values[i] is { } v) perStep[i][x.Node] = v;
            }, ct);
        return perStep.Cast<IReadOnlyDictionary<string, double>>().ToList();
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

        var wanted = nodeIds
            .Select(node => (Node: node, Feed: FeedFor(list, node, metric)))
            .Where(x => x.Feed is not null)
            .ToList();

        await ReadEachAsync(wanted,
            x => $"{baseUrl}/feed/data.json?id={Uri.EscapeDataString(x.Feed!)}&start={at - window}&end={at + window}"
               + $"&interval={Math.Max(1, cfg.History.ToleranceSeconds)}&apikey={Uri.EscapeDataString(key)}",
            (x, body) => { if (EmonCmsWire.PointAt(body, at) is { } v) found[x.Node] = v; }, ct);
        return found;
    }

    /// <summary>The feed a node's metric is stored under: the key the export writes, then the older fallbacks.</summary>
    private string? FeedFor(IReadOnlyDictionary<string, string> list, string node, string metric)
    {
        var wanted = MetricsHelper.EmonCmsFlowInputName(node, node, "", metric, cfg);
        if (list.TryGetValue(wanted, out var id)) return id;
        if (list.TryGetValue($"{node}_{metric}", out id)) return id;
        return list.TryGetValue(node, out id) ? id : null;
    }

    /// <summary>The feed list, re-read every few minutes: feeds are created rarely, and once per node per view is a lot of calls.</summary>
    private async Task<IReadOnlyDictionary<string, string>> FeedsAsync(string baseUrl, string key, CancellationToken ct)
    {
        if (feeds is not null && DateTime.UtcNow - feedsAt < TimeSpan.FromMinutes(5)) return feeds;
        // A big installation's list is hundreds of feeds and most of a second; it is read once per window,
        // not once per node, and what it holds barely changes.
        try
        {
            var response = await http.GetAsync($"{baseUrl}/feed/list.json?apikey={Uri.EscapeDataString(key)}", ct);
            if (!response.IsSuccessStatusCode)
            {
                Log.Warning($"Flow history: EmonCMS answered {(int)response.StatusCode} listing feeds.");
                return feeds ?? new Dictionary<string, string>();
            }
            feeds = EmonCmsWire.Feeds(await response.Content.ReadAsStringAsync(ct));
            feedsAt = DateTime.UtcNow;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            Log.Warning($"Flow history: could not list EmonCMS feeds ({ex.Message}).");
        }
        return feeds ?? new Dictionary<string, string>();
    }
}
