using System.Globalization;
using System.Net;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Core.History;
using rPDU2MQTT.Integrations.EmonCms;
using rPDU2MQTT.Integrations.HomeAssistant;
using rPDU2MQTT.Integrations.Local;
using rPDU2MQTT.Services;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>Copying history between backends: every node, only what the destination lacks, and no gap filled with a stale reading.</summary>
public class HistoryCopyTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "rpdu-copy-" + Guid.NewGuid().ToString("N")[..8]);

    public void Dispose()
    {
        try { if (Directory.Exists(root)) Directory.Delete(root, recursive: true); } catch (IOException) { }
    }

    private sealed class NoLive : IFlowValueSource
    {
        public bool TryGetValue(string node, string metric, out double value) { value = 0; return false; }
    }

    private sealed class Stub(Func<HttpRequestMessage, string> answer) : HttpMessageHandler
    {
        public List<(string Url, string? Body)> Requests { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Requests.Add((request.RequestUri!.ToString(), request.Content is null ? null : await request.Content.ReadAsStringAsync(ct)));
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(answer(request)) };
        }
    }

    /// <summary>A source that answers every read from a fixed set of readings, and remembers which nodes it was asked for.</summary>
    private sealed class Fixed(Dictionary<string, List<(DateTime At, double Value)>> readings, int failEvery = 0) : IMeasurementHistory
    {
        public List<string> Asked { get; } = [];
        public string Id => "fixed";
        public Task<IReadOnlyDictionary<string, double>> ValuesAtAsync(IReadOnlyCollection<string> nodeIds, string metric, DateTime atUtc, CancellationToken ct)
            => Task.FromResult<IReadOnlyDictionary<string, double>>(new Dictionary<string, double>());
        public Task<(bool Ok, string Detail)> ProbeAsync(CancellationToken ct) => Task.FromResult((true, ""));
        public Task<IReadOnlyDictionary<string, IReadOnlyList<(DateTime At, double Value)>>> ReadingsAsync(
            IReadOnlyCollection<string> nodeIds, string metric, DateTime fromUtc, DateTime toUtc, int intervalSeconds, CancellationToken ct)
        {
            lock (Asked) Asked.AddRange(nodeIds.Select(n => $"{n}|{metric}"));
            var found = nodeIds
                .Where(n => readings.ContainsKey($"{n}|{metric}"))
                .ToDictionary(n => n, n => (IReadOnlyList<(DateTime, double)>)readings[$"{n}|{metric}"].Where(r => r.At >= fromUtc && r.At < toUtc).ToList());
            // Some feeds failing: what arrived comes with the failure.
            if (failEvery > 0 && found.Count > 0) throw new PartialReadException("a feed failed", found, 1);
            return Task.FromResult<IReadOnlyDictionary<string, IReadOnlyList<(DateTime At, double Value)>>>(found);
        }
    }

    private Config Configured()
    {
        var cfg = new Config();
        cfg.History.LocalPath = root;
        cfg.EmonCMS.Url = "http://emon.local";
        cfg.EmonCMS.ApiKey = "k";
        cfg.EnergyFlow.Nodes.Add(new() { Id = "grid", Kind = "grid" });
        cfg.EnergyFlow.Nodes.Add(new() { Id = "main", Kind = "panel" });
        cfg.EnergyFlow.Links.Add(new() { From = "grid", To = "main" });
        return cfg;
    }

    private HistoryCopyService Copier(Config cfg, LocalSeriesStore store, IMeasurementHistory? source = null)
        => new(cfg, new Dictionary<string, IMeasurementHistory> { ["fixed"] = source ?? new Fixed([]), ["local"] = new LocalFlowHistory(cfg, store), ["prometheus"] = new Fixed([]) },
               [new LocalHistoryTarget(cfg, store)], store, new NoLive());

    [Fact]
    public async Task EveryNodesReadingsReachTheDestination()
    {
        var cfg = Configured();
        var store = new LocalSeriesStore(root, rawIntervalSeconds: 10);
        var now = DateTime.UtcNow;
        var recent = now.AddHours(-2);
        var old = now.AddDays(-40);
        var source = new Fixed(new()
        {
            ["grid|realpower"] = [(recent, 800), (recent.AddSeconds(10), 810)],
            ["main|energy"] = [(old, 1234.5)],
        });

        await Copier(cfg, store, source).RunAsync(source, new LocalHistoryTarget(cfg, store), 3650, CancellationToken.None);

        Assert.Equal(810, store.ValueAt("grid", "realpower", recent.AddSeconds(10), now));
        Assert.Equal(1234.5, store.ValueAt("main", "energy", old, now));
    }

    [Fact]
    public async Task TheStatusSaysHowFarBackTheCopyReached()
    {
        var cfg = Configured();
        var store = new LocalSeriesStore(root, rawIntervalSeconds: 10);
        var now = DateTime.UtcNow;
        var oldest = now.AddDays(-40).AddSeconds(-now.Second);
        var source = new Fixed(new() { ["grid|realpower"] = [(oldest, 1), (now.AddHours(-1), 2)] });
        var copier = Copier(cfg, store, source);

        await copier.RunAsync(source, new LocalHistoryTarget(cfg, store), 3650, CancellationToken.None);

        var status = copier.Status();
        Assert.Equal(oldest, (DateTime?)status.GetType().GetProperty("oldestCopied")!.GetValue(status));
        // Forty days back is past the raw tier, so the minute tier holds it: the time is known to the minute, not the day.
        Assert.Equal(oldest.AddTicks(-(oldest.Ticks % TimeSpan.TicksPerMinute)), store.Oldest());
    }

    [Fact]
    public void AnEmptyStoreHasNoOldestReading() => Assert.Null(new LocalSeriesStore(root).Oldest());

    [Fact]
    public void TheSpansCoverEveryTierOnce_NewestFirst()
    {
        var store = new LocalSeriesStore(root, rawIntervalSeconds: 10, rawKeepDays: 7, minuteKeepDays: 90);
        var now = new DateTime(2026, 9, 27, 12, 0, 0, DateTimeKind.Utc);
        var windows = Copier(Configured(), store).Windows(now, 120);

        Assert.Equal(now, windows[0].To);
        Assert.Equal(now.AddDays(-120), windows[^1].From);
        for (var i = 1; i < windows.Count; i++) Assert.Equal(windows[i - 1].From, windows[i].To);
        Assert.All(windows.Where(w => w.From >= now.AddDays(-7)), w => Assert.Equal(10, w.Interval));
        Assert.All(windows.Where(w => w.To <= now.AddDays(-90)), w => Assert.Equal(3600, w.Interval));
        Assert.All(windows, w => Assert.True((w.To - w.From).TotalSeconds / w.Interval <= 8000));
    }

    [Fact]
    public void ACopyNeedsTwoBackends_AndADestinationThatCanBeWritten()
    {
        var copier = Copier(Configured(), new LocalSeriesStore(root));
        Assert.Contains("two different", Message(copier.Start("local", "local")));
        Assert.Contains("remote-write", Message(copier.Start("local", "prometheus")));
        Assert.False(copier.Running);
    }

    private static string Message(object result) => (string)result.GetType().GetProperty("message")!.GetValue(result)!;

    [Fact]
    public async Task ReplacingOverwritesWhatTheDestinationHeld_OnlyWhereTheSourceHasAReading()
    {
        var cfg = Configured();
        var store = new LocalSeriesStore(root, rawIntervalSeconds: 10);
        var now = DateTime.UtcNow;
        var at = now.AddHours(-2).AddTicks(-(now.Ticks % TimeSpan.TicksPerMinute));
        store.Write("grid", "realpower", at, 100);
        store.Write("grid", "realpower", at.AddSeconds(10), 200);
        var source = new Fixed(new() { ["grid|realpower"] = [(at, 999)] });
        var copier = Copier(cfg, store, source);

        Assert.Contains("replacing", Message(copier.Start("fixed", "local", 1, replace: true)));
        for (var i = 0; copier.Running && i < 100; i++) await Task.Delay(50);

        Assert.Equal(999, store.ValueAt("grid", "realpower", at, now));
        Assert.Equal(200, store.ValueAt("grid", "realpower", at.AddSeconds(10), now));
    }

    [Fact]
    public void EmonCmsCannotBeAskedToReplace()
    {
        var cfg = Configured();
        var store = new LocalSeriesStore(root);
        var copier = new HistoryCopyService(cfg, new Dictionary<string, IMeasurementHistory> { ["local"] = new LocalFlowHistory(cfg, store), ["emoncms"] = new Fixed([]) },
            [new LocalHistoryTarget(cfg, store), new EmonCmsHistoryTarget(new HttpClient(), cfg)], store, new NoLive());

        Assert.Contains("no way to delete", Message(copier.Start("local", "emoncms", replace: true)));
        Assert.False(copier.Running);
    }

    [Fact]
    public void TheStoreSaysWhichStretchesOfAWindowItLacks()
    {
        var store = new LocalSeriesStore(root, rawIntervalSeconds: 10);
        var at = new DateTime(2026, 9, 20, 10, 0, 0, DateTimeKind.Utc);
        store.Import("grid", "realpower", Enumerable.Range(0, 360).Select(i => (at.AddSeconds(10 * i), 1d)), at.AddDays(1));

        Assert.Empty(store.Missing("grid", "realpower", at, at.AddHours(1), 10));
        Assert.Equal([(at.AddHours(1), at.AddHours(2))], store.Missing("grid", "realpower", at, at.AddHours(2), 10));
        Assert.Equal([(at, at.AddHours(1))], store.Missing("nobody", "realpower", at, at.AddHours(1), 10));
    }

    [Fact]
    public void OnlyTheGapsAreMissing_NotEverythingBetweenThem()
    {
        var store = new LocalSeriesStore(root, rawIntervalSeconds: 10);
        var at = new DateTime(2026, 9, 20, 10, 0, 0, DateTimeKind.Utc);
        var all = Enumerable.Range(0, 1080).Select(i => (At: at.AddSeconds(10 * i), Value: 1d)).ToList();
        // A missed sweep (2 slots), and two restarts (10 slots each) two hours apart.
        store.Import("a", "realpower", all.Where((_, i) => i is not (100 or 101)), at.AddDays(1));
        store.Import("b", "realpower", all.Where((_, i) => i is (< 100 or >= 110) and (< 900 or >= 910)), at.AddDays(1));

        Assert.Empty(store.Missing("a", "realpower", at, at.AddHours(3), 10));
        Assert.Equal([(at.AddSeconds(1000), at.AddSeconds(1100)), (at.AddSeconds(9000), at.AddSeconds(9100))],
                     store.Missing("b", "realpower", at, at.AddHours(3), 10));
    }

    [Fact]
    public async Task ARerunDoesNotReadWhatTheDestinationAlreadyHas()
    {
        var cfg = Configured();
        var store = new LocalSeriesStore(root, rawIntervalSeconds: 10);
        var now = DateTime.UtcNow;
        var dayAgo = now.AddDays(-1);
        // The destination already holds every raw reading of the last day for grid.
        store.Import("grid", "realpower", Enumerable.Range(0, 8640 + 10).Select(i => (dayAgo.AddSeconds(10 * i - 50), 1d)), now);
        var source = new Fixed([]);

        await Copier(cfg, store, source).RunAsync(source, new LocalHistoryTarget(cfg, store), 1, CancellationToken.None);

        Assert.DoesNotContain("grid|realpower", source.Asked);
        Assert.Contains("main|realpower", source.Asked);
    }

    [Fact]
    public async Task ARestartGapIsOneSmallReadForEveryNode()
    {
        var cfg = Configured();
        var store = new LocalSeriesStore(root, rawIntervalSeconds: 10);
        var now = DateTime.UtcNow;
        var dayAgo = now.AddDays(-1);
        // Two restarts, twelve hours apart, when nothing was recorded for two minutes.
        var restarts = new[] { now.AddHours(-18), now.AddHours(-6) };
        foreach (var node in new[] { "grid", "main" })
            store.Import(node, "realpower", Enumerable.Range(-5, 8650).Select(i => (At: dayAgo.AddSeconds(10 * i), Value: 1d))
                                                  .Where(r => restarts.All(x => r.At < x || r.At >= x.AddMinutes(2))), now);
        var source = new Spans();

        await Copier(cfg, store, source).RunAsync(source, new LocalHistoryTarget(cfg, store), 1, CancellationToken.None);

        var reads = source.Reads.Where(r => r.Metric == "realpower" && r.Nodes.Contains("grid")).ToList();
        Assert.Equal(2, reads.Count);
        Assert.All(reads, read =>
        {
            Assert.Contains("main", read.Nodes);
            Assert.True(read.To - read.From <= TimeSpan.FromMinutes(3), $"read {read.From:u}–{read.To:u} for a two-minute gap");
        });
    }

    /// <summary>A source that has nothing, and remembers each read's nodes and span.</summary>
    private sealed class Spans : IMeasurementHistory
    {
        public List<(string Metric, List<string> Nodes, DateTime From, DateTime To)> Reads { get; } = [];
        public string Id => "spans";
        public Task<IReadOnlyDictionary<string, double>> ValuesAtAsync(IReadOnlyCollection<string> nodeIds, string metric, DateTime atUtc, CancellationToken ct)
            => Task.FromResult<IReadOnlyDictionary<string, double>>(new Dictionary<string, double>());
        public Task<(bool Ok, string Detail)> ProbeAsync(CancellationToken ct) => Task.FromResult((true, ""));
        public Task<IReadOnlyDictionary<string, IReadOnlyList<(DateTime At, double Value)>>> ReadingsAsync(
            IReadOnlyCollection<string> nodeIds, string metric, DateTime fromUtc, DateTime toUtc, int intervalSeconds, CancellationToken ct)
        {
            lock (Reads) Reads.Add((metric, nodeIds.ToList(), fromUtc, toUtc));
            return Task.FromResult<IReadOnlyDictionary<string, IReadOnlyList<(DateTime At, double Value)>>>(new Dictionary<string, IReadOnlyList<(DateTime, double)>>());
        }
    }

    [Fact]
    public async Task WhatArrivesIsWrittenEvenWhenSomeFeedsFail()
    {
        var cfg = Configured();
        var store = new LocalSeriesStore(root, rawIntervalSeconds: 10);
        var now = DateTime.UtcNow;
        var at = now.AddHours(-1);
        var source = new Fixed(new() { ["grid|realpower"] = [(at, 42)] }, failEvery: 1);
        var copier = Copier(cfg, store, source);

        await copier.RunAsync(source, new LocalHistoryTarget(cfg, store), 1, CancellationToken.None);

        Assert.Equal(42, store.ValueAt("grid", "realpower", at, now));
        var status = copier.Status();
        Assert.True((int)status.GetType().GetProperty("feedsFailed")!.GetValue(status)! > 0);
        Assert.Contains("run it again", (string)status.GetType().GetProperty("message")!.GetValue(status)!);
    }

    [Fact]
    public void TheLocalStoreGivesBackOnlyWhatItHolds()
    {
        var store = new LocalSeriesStore(root, rawIntervalSeconds: 10);
        var at = new DateTime(2026, 9, 20, 10, 0, 0, DateTimeKind.Utc);
        store.Write("grid", "realpower", at, 1);
        store.Write("grid", "realpower", at.AddSeconds(50), 2);

        var found = store.Readings("grid", "realpower", at, at.AddMinutes(1), 10);
        Assert.Equal([(at, 1d), (at.AddSeconds(50), 2d)], found);
        // No minute roll-up has run, so a minute read falls back to what the raw tier holds.
        Assert.Equal(2, store.Readings("grid", "realpower", at, at.AddMinutes(1), 60).Count);
    }

    [Fact]
    public async Task AnEmonCmsGapStaysAGap()
    {
        var cfg = Configured();
        var handler = new Stub(r => r.RequestUri!.AbsolutePath.EndsWith("list.json")
            ? """[{"id":"7","name":"grid_realpower"}]"""
            : "[[1790000000000,5],[1790000010000,null],[1790000020000,null],[1790000030000,6]]");
        var history = new EmonCmsFlowHistory(new HttpClient(handler), cfg);
        var from = DateTimeOffset.FromUnixTimeSeconds(1790000000).UtcDateTime;

        var found = await history.ReadingsAsync(["grid"], "realpower", from, from.AddSeconds(40), 10, CancellationToken.None);

        Assert.Equal([(from, 5d), (from.AddSeconds(30), 6d)], found["grid"]);
    }

    [Fact]
    public async Task EmonCmsIsOnlyWrittenWhereTheFeedHoldsNothing()
    {
        var cfg = Configured();
        var handler = new Stub(r => r.RequestUri!.AbsolutePath switch
        {
            var p when p.EndsWith("list.json") => """[{"id":"7","name":"grid_realpower"}]""",
            var p when p.EndsWith("data.json") => "[[1790000000000,5],[1790000010000,null]]",
            _ => """{"success":true}""",
        });
        var target = new EmonCmsHistoryTarget(new HttpClient(handler), cfg);
        await target.PrepareAsync(CancellationToken.None);
        var at = DateTimeOffset.FromUnixTimeSeconds(1790000000).UtcDateTime;

        var written = await target.WriteAsync("grid", "grid", "grid", "realpower", [(at, 99), (at.AddSeconds(10), 6)], 10, DateTime.UtcNow, false, CancellationToken.None);

        Assert.Equal(1, written);
        var post = Assert.Single(handler.Requests, r => r.Body is not null);
        Assert.Contains("insert.json?id=7", post.Url);
        Assert.Equal("data=" + Uri.EscapeDataString("[[1790000010,6]]"), post.Body);
        // A series with no feed is not written, and no feed is created for it.
        Assert.Equal(0, await target.WriteAsync("main", "main", "panel", "realpower", [(at, 1)], 10, DateTime.UtcNow, false, CancellationToken.None));
    }

    [Fact]
    public async Task AHomeAssistantReadingEndsWhenTheSensorGoesUnavailable()
    {
        var cfg = new Config();
        cfg.HASS.EnergyDashboard.Url = "http://hass.local";
        cfg.HASS.EnergyDashboard.Token = "t";
        var start = new DateTime(2026, 8, 20, 5, 0, 0, DateTimeKind.Utc);
        string At(int minutes) => start.AddMinutes(minutes).ToString("o", CultureInfo.InvariantCulture);
        var handler = new Stub(_ => $$"""[[{"entity_id":"sensor.energyflow_grid_energy","state":"10","last_changed":"{{At(0)}}"},{"entity_id":"sensor.energyflow_grid_energy","state":"unavailable","last_changed":"{{At(10)}}"}]]""");
        var history = new HomeAssistantHistory(new HttpClient(handler), cfg);

        var series = await history.SeriesAsync(["grid"], "energy", [start.AddMinutes(5), start.AddMinutes(15)], CancellationToken.None);

        Assert.Equal(10, series[0]["grid"]);
        Assert.Empty(series[1]);
    }
}
