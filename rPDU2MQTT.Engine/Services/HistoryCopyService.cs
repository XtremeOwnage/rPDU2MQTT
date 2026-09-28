using rPDU2MQTT.Classes;
using rPDU2MQTT.Core;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Core.History;
using rPDU2MQTT.Models.PDU;
using Serilog;

namespace rPDU2MQTT.Services;

/// <summary>Copies every node's history from one backend to another in the background, filling only what the destination lacks.</summary>
public sealed class HistoryCopyService(Config cfg, IReadOnlyDictionary<string, IMeasurementHistory> sources,
                                       IEnumerable<IHistoryTarget> targets, LocalSeriesStore store, IFlowValueSource live,
                                       ISnapshotCache? snapshots = null, LeaderState? leader = null)
{
    // Steps per read: EmonCMS refuses more than 8928 points, Prometheus more than 11000.
    private const int StepsPerRead = 8000;
    // Nodes per read, which keeps a Prometheus node matcher or a Home Assistant entity list to a sane URL.
    private const int NodesPerRead = 40;

    private readonly IReadOnlyList<IHistoryTarget> targets = targets.ToList();
    private readonly object sync = new();
    private Task? running;
    private string? from, to;
    private DateTime? startedUtc, finishedUtc;
    private int reads, readsDone, failed;
    private long copied, written;
    private DateTime? oldestCopied, newestCopied, readingFrom, readingTo;
    private int readingInterval;
    private string message = "No copy has run.";

    public bool Running => running is { IsCompleted: false };

    /// <summary>Why a backend cannot be read from, or null when it can.</summary>
    public string? SourceUnavailable(string id) => id switch
    {
        _ when !sources.ContainsKey(id) => "not a history backend",
        "emoncms" when string.IsNullOrWhiteSpace(cfg.EmonCMS.Url) => "EmonCMS.Url is not set",
        "prometheus" when string.IsNullOrWhiteSpace(cfg.History.PrometheusUrl) => "History.PrometheusUrl is not set",
        "homeassistant" when string.IsNullOrWhiteSpace(cfg.HASS.EnergyDashboard.Url) || string.IsNullOrWhiteSpace(cfg.HASS.EnergyDashboard.Token)
            => "the Home Assistant URL and token are not set",
        _ => null,
    };

    /// <summary>Why a backend cannot be written to, or null when it can.</summary>
    public string? TargetUnavailable(string id)
        => targets.FirstOrDefault(t => string.Equals(t.Id, id, StringComparison.OrdinalIgnoreCase)) is { } t
            ? t.Unavailable
            : id switch
            {
                "prometheus" => "Prometheus only takes past samples through its remote-write receiver, which this bridge does not write to",
                "homeassistant" => "Home Assistant only takes past readings as hourly statistics, which this bridge does not write",
                _ => "not a history backend",
            };

    public object Backends() => sources.Keys.Select(id => new
    {
        id,
        read = SourceUnavailable(id),
        write = TargetUnavailable(id),
    }).ToList();

    /// <summary>Start a copy unless one is running. `days` limits how far back it reads; 0 reads ten years.</summary>
    public object Start(string source, string target, int days = 0)
    {
        source = (source ?? "").Trim().ToLowerInvariant();
        target = (target ?? "").Trim().ToLowerInvariant();
        if (source == target) return new { ok = false, message = "Choose two different backends." };
        if (SourceUnavailable(source) is { } noRead) return new { ok = false, message = $"Cannot read from {source}: {noRead}." };
        if (TargetUnavailable(target) is { } noWrite) return new { ok = false, message = $"Cannot write to {target}: {noWrite}." };
        // The recorder owns the local store's files; a second process writing them is corruption.
        if (target == "local" && leader is not null && !leader.IsLeader)
            return new { ok = false, message = "Only the instance that records history can write to it; this one is not the leader." };
        var sink = targets.First(t => string.Equals(t.Id, target, StringComparison.OrdinalIgnoreCase));

        lock (sync)
        {
            if (Running) return new { ok = false, message = $"A copy is already running: {message}" };
            (from, to) = (source, target);
            startedUtc = DateTime.UtcNow;
            finishedUtc = null;
            reads = readsDone = failed = 0;
            copied = written = 0;
            oldestCopied = newestCopied = readingFrom = readingTo = null;
            readingInterval = 0;
            message = "Starting…";
            running = Task.Run(() => RunAsync(sources[source], sink, days <= 0 ? 3650 : days, CancellationToken.None));
        }
        return new { ok = true, message = $"Copying history from {source} to {target}." };
    }

    public object Status()
    {
        lock (sync)
            return new
            {
                ok = true, running = Running, from, to, message, reads, readsDone, readsFailed = failed,
                readingsCopied = copied, slotsWritten = written, started = startedUtc, finished = finishedUtc,
                oldestCopied, newestCopied,
                // The span being read now; the copy works newest first, so its start is how far back it has got.
                window = readingFrom is null ? null : new { from = readingFrom, to = readingTo, intervalSeconds = readingInterval },
            };
    }

    /// <summary>The copy itself: each tier's span at that tier's interval, a window of steps and a group of nodes at a time.</summary>
    internal async Task RunAsync(IMeasurementHistory source, IHistoryTarget target, int days, CancellationToken ct)
    {
        try
        {
            await target.PrepareAsync(ct);
            var now = DateTime.UtcNow;
            var nodes = Nodes();
            var windows = Windows(now, days);
            var groups = nodes.Chunk(NodesPerRead).ToList();
            lock (sync) { reads = windows.Count * groups.Count * FlowUnits.Metrics.Length; message = $"Copying {nodes.Count} series per metric over {days} days…"; }
            Log.Information($"History copy: {source.Id} to {target.Id}, {nodes.Count} nodes, {windows.Count} windows, {days} days.");

            foreach (var (start, end, interval) in windows)
            {
                lock (sync) { readingFrom = start; readingTo = end; readingInterval = interval; }
                foreach (var metric in FlowUnits.Metrics)
                    foreach (var group in groups)
                    {
                        ct.ThrowIfCancellationRequested();
                        try
                        {
                            var found = await source.ReadingsAsync(group.Select(n => n.Id).ToList(), metric, start, end, interval, ct);
                            long got = 0, put = 0;
                            foreach (var node in group)
                                if (found.TryGetValue(node.Id, out var readings) && readings.Count > 0)
                                {
                                    got += readings.Count;
                                    var (first, last) = (readings.Min(r => r.At), readings.Max(r => r.At));
                                    lock (sync)
                                    {
                                        if (oldestCopied is null || first < oldestCopied) oldestCopied = first;
                                        if (newestCopied is null || last > newestCopied) newestCopied = last;
                                    }
                                    put += await target.WriteAsync(node.Id, node.Label, node.Kind, metric, readings, interval, now, ct);
                                }
                            lock (sync) { readsDone++; copied += got; written += put; message = $"{readsDone} of {reads} reads, {copied:N0} readings copied, {written:N0} written."; }
                        }
                        catch (Exception ex) when (ex is not OperationCanceledException)
                        {
                            lock (sync) { readsDone++; failed++; }
                            Log.Warning($"History copy: {metric} {start:u}–{end:u} failed ({ex.Message}).");
                        }
                    }
            }

            lock (sync) message = $"Finished: {copied:N0} readings copied from {source.Id}, {written:N0} written to {target.Id}"
                                + (failed > 0 ? $"; {failed} of {reads} reads failed (see the log)." : ".");
        }
        catch (Exception ex)
        {
            lock (sync) message = $"Copy stopped: {ex.Message}";
        }
        finally
        {
            lock (sync) finishedUtc = DateTime.UtcNow;
            Log.Information($"History copy: {message}");
        }
    }

    /// <summary>Every node the graph has, and the return lane of each, as the recorder names them.</summary>
    private List<(string Id, string Label, string Kind)> Nodes()
    {
        var graph = FlowGraphBuilder.Build(snapshots?.Latest?.Data ?? new PduData(), cfg.EnergyFlow, FlowGraphBuilder.DefaultMetric, live);
        var nodes = new List<(string, string, string)>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var n in graph.Nodes)
        {
            if (seen.Add(n.Id)) nodes.Add((n.Id, n.Label, n.Kind));
            var lane = n.Id + FlowMetricKey.InSuffix;
            if (!n.ReturnLane && seen.Add(lane)) nodes.Add((lane, FlowMetricKey.ReturnLabel(n.Label, n.Kind), n.Kind));
        }
        return nodes;
    }

    /// <summary>The spans to read, newest first: each local tier's span at its interval, cut into reads of at most `StepsPerRead` steps.</summary>
    internal List<(DateTime From, DateTime To, int Interval)> Windows(DateTime now, int days)
    {
        var windows = new List<(DateTime, DateTime, int)>();
        var oldest = now.AddDays(-days);
        var newer = now;
        foreach (var tier in store.Tiers)
        {
            var from = now.AddDays(-tier.KeepDays);
            if (from < oldest) from = oldest;
            var span = TimeSpan.FromSeconds((double)tier.IntervalSeconds * StepsPerRead);
            for (var end = newer; end > from; end -= span)
                windows.Add((end - span < from ? from : end - span, end, tier.IntervalSeconds));
            if (from < newer) newer = from;
            if (newer <= oldest) break;
        }
        return windows;
    }
}
