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
    // More separate gaps than this in one series and window are read as one stretch.
    private const int MaxGapsPerRead = 12;

    private readonly IReadOnlyList<IHistoryTarget> targets = targets.ToList();
    private readonly object sync = new();
    private Task? running;
    private string? from, to;
    private DateTime? startedUtc, finishedUtc;
    private int reads, readsDone, failed, skipped, feedsFailed;
    private long copied, written, seriesChecked, seriesComplete;
    private DateTime? oldestCopied, newestCopied, readingFrom, readingTo;
    private int readingInterval;
    private bool replacing;
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
        replace = Target(id)?.CannotReplace,
    }).ToList();

    private IHistoryTarget? Target(string id) => targets.FirstOrDefault(t => string.Equals(t.Id, id, StringComparison.OrdinalIgnoreCase));

    /// <summary>Start a copy unless one is running. `days` limits how far back it reads (0 reads ten years); `replace` overwrites what the destination holds.</summary>
    public object Start(string source, string target, int days = 0, bool replace = false)
    {
        source = (source ?? "").Trim().ToLowerInvariant();
        target = (target ?? "").Trim().ToLowerInvariant();
        if (source == target) return new { ok = false, message = "Choose two different backends." };
        if (SourceUnavailable(source) is { } noRead) return new { ok = false, message = $"Cannot read from {source}: {noRead}." };
        if (TargetUnavailable(target) is { } noWrite) return new { ok = false, message = $"Cannot write to {target}: {noWrite}." };
        // The recorder owns the local store's files; a second process writing them is corruption.
        if (target == "local" && leader is not null && !leader.IsLeader)
            return new { ok = false, message = "Only the instance that records history can write to it; this one is not the leader." };
        var sink = Target(target)!;
        if (replace && sink.CannotReplace is { } noReplace) return new { ok = false, message = $"Cannot replace readings in {target}: {noReplace}. Fill the gaps instead." };

        lock (sync)
        {
            if (Running) return new { ok = false, message = $"A copy is already running: {message}" };
            (from, to) = (source, target);
            replacing = replace;
            startedUtc = DateTime.UtcNow;
            finishedUtc = null;
            reads = readsDone = failed = skipped = feedsFailed = 0;
            copied = written = seriesChecked = seriesComplete = 0;
            oldestCopied = newestCopied = readingFrom = readingTo = null;
            readingInterval = 0;
            message = "Starting…";
            running = Task.Run(() => RunAsync(sources[source], sink, days <= 0 ? 3650 : days, CancellationToken.None));
        }
        return new { ok = true, message = $"Copying history from {source} to {target}, {(replace ? "replacing what is there" : "filling gaps only")}." };
    }

    public object Status()
    {
        lock (sync)
            return new
            {
                ok = true, running = Running, from, to, conflicts = replacing ? "replace" : "keep", message, reads, readsDone, readsFailed = failed, readsSkipped = skipped, feedsFailed, seriesChecked, seriesComplete,
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
                        // Filling gaps, only the stretches the destination lacks are read, and a stretch every node lacks
                        // (a restart, when nothing was recorded) is one read for all of them.
                        var spans = new Dictionary<(DateTime From, DateTime To), List<(string Id, string Label, string Kind)>>();
                        // A series needed nothing when nothing is written for it: no gap, or none the source can fill.
                        var wrote = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                        foreach (var node in group)
                        {
                            var gaps = replacing ? [(start, end)] : target.Missing(node.Id, metric, start, end, interval);
                            // Past a handful, one read of the whole stretch costs less than a read per gap.
                            if (gaps.Count > MaxGapsPerRead) gaps = [(gaps[0].From, gaps[^1].To)];
                            foreach (var gap in gaps)
                                (spans.TryGetValue(gap, out var sharing) ? sharing : spans[gap] = []).Add(node);
                        }
                        if (spans.Count == 0)
                        {
                            lock (sync) { readsDone++; skipped++; seriesChecked += group.Length; seriesComplete += group.Length; }
                            continue;
                        }

                        long got = 0, put = 0;
                        var failedFeeds = 0;
                        var incomplete = false;
                        foreach (var ((from, to), lacking) in spans)
                        {
                            IReadOnlyDictionary<string, IReadOnlyList<(DateTime At, double Value)>> found;
                            try { found = await source.ReadingsAsync(lacking.Select(n => n.Id).ToList(), metric, from, to, interval, ct); }
                            catch (PartialReadException partial)
                            {
                                // What did arrive is still written; the rest is counted, and a re-run fills it.
                                found = partial.Found;
                                failedFeeds += partial.Failed;
                                incomplete = true;
                                Log.Warning($"History copy: {metric} {from:u}–{to:u}: {partial.Message}");
                            }
                            catch (Exception ex) when (ex is not OperationCanceledException)
                            {
                                incomplete = true;
                                Log.Warning($"History copy: {metric} {from:u}–{to:u} failed ({ex.Message}).");
                                continue;
                            }

                            foreach (var node in lacking)
                                if (found.TryGetValue(node.Id, out var readings) && readings.Count > 0)
                                {
                                    got += readings.Count;
                                    var (first, last) = (readings.Min(r => r.At), readings.Max(r => r.At));
                                    lock (sync)
                                    {
                                        if (oldestCopied is null || first < oldestCopied) oldestCopied = first;
                                        if (newestCopied is null || last > newestCopied) newestCopied = last;
                                    }
                                    var slots = await target.WriteAsync(node.Id, node.Label, node.Kind, metric, readings, interval, now, replacing, ct);
                                    if (slots > 0) wrote.Add(node.Id);
                                    put += slots;
                                }
                        }
                        lock (sync)
                        {
                            readsDone++; copied += got; written += put; feedsFailed += failedFeeds;
                            seriesChecked += group.Length; seriesComplete += group.Length - wrote.Count;
                            if (incomplete) failed++;
                            message = $"{readsDone} of {reads} reads, {copied:N0} readings copied, {written:N0} written.";
                        }
                    }
            }

            lock (sync) message = $"Finished: {copied:N0} readings copied from {source.Id}, {written:N0} written to {target.Id}"
                                + (skipped > 0 ? $"; {skipped} of {reads} reads skipped, the destination already had them" : "")
                                + (failed > 0 ? $"; {failed} reads were incomplete ({feedsFailed} feed reads failed after retries) — run it again to fill them." : ".");
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
