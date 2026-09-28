using System.Text.Json;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Core.History;
using rPDU2MQTT.Helpers;
using rPDU2MQTT.Models.PDU;
using Serilog;

namespace rPDU2MQTT.Integrations.EmonCms;

/// <summary>Copies every node's EmonCMS feed history into the local store in the background, filling only empty slots.</summary>
public sealed class EmonCmsHistoryImport(Config cfg, LocalSeriesStore store, IFlowValueSource live,
                                         ISnapshotCache? snapshots = null, LeaderState? leader = null)
{
    // EmonCMS refuses a read of more than 8928 points.
    private const int PointsPerRead = 8000;
    private const int AtOnce = 4;

    private readonly HttpClient http = new() { Timeout = TimeSpan.FromSeconds(60) };
    private readonly object sync = new();
    private Task? running;
    private DateTime? startedUtc, finishedUtc;
    private int total, done, failed;
    private long written;
    private string message = "No import has run.";

    public bool Running => running is { IsCompleted: false };

    /// <summary>Start an import unless one is running. `days` limits how far back it reads; 0 reads everything the tiers keep.</summary>
    public object Start(int days = 0)
    {
        if (!cfg.History.LocalEnabled) return new { ok = false, message = "Local history is off (History.LocalEnabled), so there is nowhere to import to." };
        if (leader is not null && !leader.IsLeader) return new { ok = false, message = "Only the instance that records history can import it; this one is not the leader." };
        var baseUrl = (cfg.EmonCMS.Url ?? "").TrimEnd('/');
        if (baseUrl.Length == 0) return new { ok = false, message = "EmonCMS.Url is not set." };

        lock (sync)
        {
            if (Running) return new { ok = false, message = $"An import is already running: {message}" };
            startedUtc = DateTime.UtcNow;
            finishedUtc = null;
            total = done = failed = 0;
            written = 0;
            message = "Listing feeds…";
            running = Task.Run(() => RunAsync(baseUrl, cfg.EmonCMS.ApiKey ?? "", days, CancellationToken.None));
        }
        return new { ok = true, message = "Import started. Use Import progress to follow it." };
    }

    public object Status()
    {
        lock (sync)
            return new
            {
                ok = true,
                running = Running,
                message,
                series = total,
                seriesDone = done,
                seriesFailed = failed,
                slotsWritten = written,
                started = startedUtc,
                finished = finishedUtc,
            };
    }

    private async Task RunAsync(string baseUrl, string key, int days, CancellationToken ct)
    {
        try
        {
            var feeds = EmonCmsWire.Feeds(await http.GetStringAsync($"{baseUrl}/feed/list.json?apikey={Uri.EscapeDataString(key)}", ct));
            var jobs = Series(feeds);
            lock (sync) { total = jobs.Count; message = $"Importing {jobs.Count} series from {feeds.Count} feeds…"; }
            Log.Information($"Local history: importing {jobs.Count} series from EmonCMS.");

            var now = DateTime.UtcNow;
            await Parallel.ForEachAsync(jobs, new ParallelOptions { MaxDegreeOfParallelism = AtOnce, CancellationToken = ct }, async (job, token) =>
            {
                try
                {
                    var slots = await ImportAsync(baseUrl, key, job, now, days, token);
                    lock (sync) { done++; written += slots; message = $"{done} of {total} series imported, {written:N0} slots written."; }
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    lock (sync) { done++; failed++; }
                    Log.Warning($"Local history: importing {job.Node} {job.Metric} from feed {job.FeedId} failed ({ex.Message}).");
                }
            });

            lock (sync) message = $"Finished: {done - failed} of {total} series imported, {written:N0} slots written" + (failed > 0 ? $", {failed} failed (see the log)." : ".");
        }
        catch (Exception ex)
        {
            lock (sync) message = $"Import stopped: {ex.Message}";
        }
        finally
        {
            lock (sync) finishedUtc = DateTime.UtcNow;
            Log.Information($"Local history: {message}");
        }
    }

    /// <summary>Every (node, metric) the store records that has a feed named the way the export names it.</summary>
    private List<(string Node, string Metric, string FeedId)> Series(IReadOnlyDictionary<string, string> feeds)
    {
        var data = snapshots?.Latest?.Data ?? new PduData();
        var graph = FlowGraphBuilder.Build(data, cfg.EnergyFlow, FlowGraphBuilder.DefaultMetric, live);
        var jobs = new List<(string, string, string)>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var node in graph.Nodes)
            foreach (var metric in FlowUnits.Metrics)
            {
                var name = MetricsHelper.EmonCmsFlowInputName(node.Id, node.Label, node.Kind, metric, cfg);
                if (feeds.TryGetValue(name, out var id) && seen.Add($"{node.Id}|{metric}")) jobs.Add((node.Id, metric, id));
            }
        return jobs;
    }

    /// <summary>One series: each tier's span read at that tier's interval, oldest first.</summary>
    private async Task<int> ImportAsync(string baseUrl, string key, (string Node, string Metric, string FeedId) job,
                                        DateTime now, int days, CancellationToken ct)
    {
        var begins = await StartOfAsync(baseUrl, key, job.FeedId, ct) ?? now.AddDays(-store.Tiers[1].KeepDays);
        if (days > 0 && begins < now.AddDays(-days)) begins = now.AddDays(-days);

        var slots = 0;
        var newer = now;
        foreach (var tier in store.Tiers)
        {
            var from = now.AddDays(-tier.KeepDays);
            if (from < begins) from = begins;
            if (from < newer)
            {
                var points = await ReadAsync(baseUrl, key, job.FeedId, from, newer, tier.IntervalSeconds, ct);
                slots += store.Import(job.Node, job.Metric, points, now);
                newer = from;
            }
            if (newer <= begins) break;
        }
        return slots;
    }

    /// <summary>When a feed's first reading was taken, or null when EmonCMS does not say.</summary>
    private async Task<DateTime?> StartOfAsync(string baseUrl, string key, string feedId, CancellationToken ct)
    {
        try
        {
            using var doc = JsonDocument.Parse(await http.GetStringAsync(
                $"{baseUrl}/feed/getmeta.json?id={Uri.EscapeDataString(feedId)}&apikey={Uri.EscapeDataString(key)}", ct));
            return doc.RootElement.ValueKind == JsonValueKind.Object
                   && doc.RootElement.TryGetProperty("start_time", out var s) && s.TryGetInt64(out var t) && t > 0
                ? DateTimeOffset.FromUnixTimeSeconds(t).UtcDateTime
                : null;
        }
        catch (Exception ex) when (ex is JsonException or HttpRequestException) { return null; }
    }

    private async Task<List<(DateTime At, double Value)>> ReadAsync(string baseUrl, string key, string feedId,
                                                                    DateTime from, DateTime to, int interval, CancellationToken ct)
    {
        var points = new List<(DateTime, double)>();
        var span = TimeSpan.FromSeconds((double)interval * PointsPerRead);
        for (var at = from; at < to; at += span)
        {
            var end = at + span < to ? at + span : to;
            var body = await http.GetStringAsync(
                $"{baseUrl}/feed/data.json?id={Uri.EscapeDataString(feedId)}&start={Ms(at)}&end={Ms(end)}"
              + $"&interval={interval}&apikey={Uri.EscapeDataString(key)}", ct);
            foreach (var (ms, value) in EmonCmsWire.Points(body))
                points.Add((DateTimeOffset.FromUnixTimeMilliseconds(ms).UtcDateTime, value));
        }
        return points;
    }

    private static long Ms(DateTime at) => new DateTimeOffset(DateTime.SpecifyKind(at, DateTimeKind.Utc)).ToUnixTimeMilliseconds();
}
