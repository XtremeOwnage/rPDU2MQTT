using System.Globalization;
using System.Net;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Integrations.EmonCms;
using rPDU2MQTT.Integrations.HomeAssistant;

namespace rPDU2MQTT.Tests;

/// <summary>
/// How many requests a chart costs on each history backend.
///
/// <para>
/// <c>IMeasurementHistory.SeriesAsync</c> has a default implementation that calls <c>ValuesAtAsync</c> once
/// per step. Prometheus overrides it with a range query; EmonCMS and Home Assistant did not. A day of
/// five-minute steps is 289 of them, and the EmonCMS reader makes a request per node on top — 8,670
/// sequential requests for one chart on a thirty-node hierarchy.
/// </para>
/// <para>
/// The GUI caps a series build at 60 seconds, so this was never a slow chart: it was an empty Trends page
/// on a backend holding every reading asked for. These tests count requests, because the count IS the
/// defect — the parsing was always fine.
/// </para>
/// </summary>
public class HistorySeriesTests
{
    private sealed class Counting : HttpMessageHandler
    {
        private readonly Func<string, string> body;
        public Counting(Func<string, string> body) => this.body = body;
        public List<string> Urls { get; } = new();

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            var url = request.RequestUri!.ToString();
            Urls.Add(url);
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(body(url)),
            });
        }
    }

    private static List<DateTime> Day(int steps = 289)
    {
        var start = new DateTime(2026, 8, 20, 5, 0, 0, DateTimeKind.Utc);
        return Enumerable.Range(0, steps).Select(i => start.AddMinutes(5 * i)).ToList();
    }

    // --- EmonCMS ------------------------------------------------------------------------------------

    private static string EmonBody(string url, IReadOnlyList<DateTime> steps)
    {
        if (url.Contains("/feed/list.json"))
            return """[{"id":"7","name":"grid_energy"},{"id":"8","name":"solar_energy"}]""";

        // A point on every step, valued by its index so the mapping can be checked exactly.
        var points = steps.Select((s, i) =>
            $"[{new DateTimeOffset(s).ToUnixTimeMilliseconds()},{i}]");
        return "[" + string.Join(",", points) + "]";
    }

    private static Config EmonConfigured()
    {
        var cfg = new Config();
        cfg.EmonCMS.Url = "http://emon.local";
        cfg.EmonCMS.ApiKey = "k";
        cfg.History.Provider = "emoncms";
        return cfg;
    }

    [Fact]
    public async Task EmonCms_ReadsAWindowOncePerNode_NotOncePerStep()
    {
        var steps = Day();
        var handler = new Counting(url => EmonBody(url, steps));
        var history = new EmonCmsFlowHistory(new HttpClient(handler), EmonConfigured());

        var series = await history.SeriesAsync(new[] { "grid", "solar" }, "energy", steps, CancellationToken.None);

        Assert.Equal(steps.Count, series.Count);
        var feedReads = handler.Urls.Count(u => u.Contains("/feed/data.json"));
        Assert.True(feedReads <= 2,
            $"{feedReads} feed reads for 2 nodes over {steps.Count} steps — the window is read per step, "
          + "which is what makes the chart time out rather than draw");
    }

    [Fact]
    public async Task EmonCms_MapsEachStepToItsOwnPoint()
    {
        var steps = Day(6);
        var handler = new Counting(url => EmonBody(url, steps));
        var history = new EmonCmsFlowHistory(new HttpClient(handler), EmonConfigured());

        var series = await history.SeriesAsync(new[] { "grid" }, "energy", steps, CancellationToken.None);

        for (var i = 0; i < steps.Count; i++)
            Assert.Equal(i, series[i]["grid"]);
    }

    /// <summary>A step before the feed's first point has nothing to report, and must not borrow a later one.</summary>
    [Fact]
    public async Task EmonCms_LeavesAStepEmptyWhenNoPointPrecedesIt()
    {
        var steps = Day(4);
        var only = new DateTimeOffset(steps[2]).ToUnixTimeMilliseconds();
        var handler = new Counting(url => url.Contains("/feed/list.json")
            ? """[{"id":"7","name":"grid_energy"}]"""
            : $"[[{only},42]]");
        var history = new EmonCmsFlowHistory(new HttpClient(handler), EmonConfigured());

        var series = await history.SeriesAsync(new[] { "grid" }, "energy", steps, CancellationToken.None);

        Assert.Empty(series[0]);
        Assert.Empty(series[1]);
        Assert.Equal(42, series[2]["grid"]);
        Assert.Equal(42, series[3]["grid"]);   // a reading holds until the next one
    }

    /// <summary>Records how many reads were in flight at once, so "several at a time" can be asserted.</summary>
    private sealed class Overlapping(Func<string, string> body, TimeSpan hold) : HttpMessageHandler
    {
        private int now;
        public int Peak;
        public int Reads;

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            var url = request.RequestUri!.ToString();
            if (url.Contains("/feed/data.json"))
            {
                Interlocked.Increment(ref Reads);
                var at = Interlocked.Increment(ref now);
                // Peak is only ever raised, by whichever reader is deepest in at the time.
                int seen;
                while (at > (seen = Volatile.Read(ref Peak)) && Interlocked.CompareExchange(ref Peak, at, seen) != seen) { }
                await Task.Delay(hold, ct);
                Interlocked.Decrement(ref now);
            }
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body(url)) };
        }
    }

    /// <summary>One feed's entry in the list, named the way the reader looks a node's metric up.</summary>
    private static string FeedEntry(int id, string node) => $"{{\"id\":\"{id}\",\"name\":\"{node}_energy\"}}";

    /// <summary>The feed id a read asked for, so each feed can answer with its own value.</summary>
    private static int AskedFor(string url) => int.Parse(System.Text.RegularExpressions.Regex.Match(url, "id=(\\d+)").Groups[1].Value);

    /// <summary>
    /// EmonCMS answers one feed per request, and one after another a hierarchy of any size is seconds of
    /// waiting before a chart can be drawn. Several feeds are read at once — and every node still lands
    /// against its own feed's readings, which is what a race would break.
    /// </summary>
    [Fact]
    public async Task EmonCms_ReadsSeveralFeedsAtOnce_AndKeepsEachNodesOwnReadings()
    {
        var steps = Day(3);
        var nodes = Enumerable.Range(1, 16).Select(i => $"n{i}").ToArray();
        var feeds = "[" + string.Join(",", nodes.Select((n, i) => FeedEntry(i + 1, n))) + "]";
        // Each feed answers with its own id as the value, so a reading landing on the wrong node is visible.
        var handler = new Overlapping(url => url.Contains("/feed/list.json")
            ? feeds
            : "[" + string.Join(",", steps.Select(st => $"[{new DateTimeOffset(st).ToUnixTimeMilliseconds()},{AskedFor(url)}]")) + "]",
            TimeSpan.FromMilliseconds(40));
        var history = new EmonCmsFlowHistory(new HttpClient(handler), EmonConfigured());

        var series = await history.SeriesAsync(nodes, "energy", steps, CancellationToken.None);

        Assert.Equal(nodes.Length, handler.Reads);
        Assert.True(handler.Peak > 1, $"the feeds were read one after another (peak {handler.Peak} in flight)");
        // …and not all at once either: a backend keeping its feeds in MySQL is not helped by fifty at a time.
        Assert.True(handler.Peak <= 8, $"{handler.Peak} reads were in flight at once");
        for (var i = 0; i < nodes.Length; i++)
            Assert.Equal(i + 1, series[0][nodes[i]]);
    }

    /// <summary>The same for a single instant: the flow diagram at a past moment asks for every node at once.</summary>
    [Fact]
    public async Task EmonCms_ReadsSeveralFeedsAtOnce_ForAnInstant()
    {
        var at = new DateTime(2026, 8, 20, 5, 0, 0, DateTimeKind.Utc);
        var nodes = Enumerable.Range(1, 12).Select(i => $"n{i}").ToArray();
        var feeds = "[" + string.Join(",", nodes.Select((n, i) => FeedEntry(i + 1, n))) + "]";
        var handler = new Overlapping(url => url.Contains("/feed/list.json")
            ? feeds
            : $"[[{new DateTimeOffset(at).ToUnixTimeMilliseconds()},{AskedFor(url)}]]",
            TimeSpan.FromMilliseconds(40));
        var history = new EmonCmsFlowHistory(new HttpClient(handler), EmonConfigured());

        var found = await history.ValuesAtAsync(nodes, "energy", at, CancellationToken.None);

        Assert.Equal(nodes.Length, found.Count);
        Assert.True(handler.Peak > 1, $"the feeds were read one after another (peak {handler.Peak} in flight)");
        for (var i = 0; i < nodes.Length; i++)
            Assert.Equal(i + 1, found[nodes[i]]);
    }

    // --- Home Assistant -----------------------------------------------------------------------------

    private static Config HassConfigured()
    {
        var cfg = new Config();
        cfg.HASS.EnergyDashboard.Url = "http://hass.local";
        cfg.HASS.EnergyDashboard.Token = "t";
        cfg.History.Provider = "homeassistant";
        return cfg;
    }

    private static string HassBody(IReadOnlyList<DateTime> steps, string entity)
    {
        var points = steps.Select((s, i) =>
            $$"""{"entity_id":"{{entity}}","state":"{{i.ToString(CultureInfo.InvariantCulture)}}","last_changed":"{{s.ToString("o", CultureInfo.InvariantCulture)}}"}""");
        return "[[" + string.Join(",", points) + "]]";
    }

    [Fact]
    public async Task HomeAssistant_ReadsTheWholeWindowInOneRequest()
    {
        var steps = Day();
        var handler = new Counting(_ => HassBody(steps, "sensor.energyflow_grid_energy"));
        var history = new HomeAssistantHistory(new HttpClient(handler), HassConfigured());

        var series = await history.SeriesAsync(new[] { "grid" }, "energy", steps, CancellationToken.None);

        Assert.Equal(steps.Count, series.Count);
        Assert.True(handler.Urls.Count == 1,
            $"{handler.Urls.Count} requests for one chart — the history endpoint takes a range, and the "
          + "Trends page gives up after 60 seconds");
    }

    [Fact]
    public async Task HomeAssistant_MapsEachStepToItsOwnState()
    {
        var steps = Day(5);
        var handler = new Counting(_ => HassBody(steps, "sensor.energyflow_grid_energy"));
        var history = new HomeAssistantHistory(new HttpClient(handler), HassConfigured());

        var series = await history.SeriesAsync(new[] { "grid" }, "energy", steps, CancellationToken.None);

        for (var i = 0; i < steps.Count; i++)
            Assert.Equal(i, series[i]["grid"]);
    }

    /// <summary>"unavailable" is a gap. A sensor that drops out must not read as a zero.</summary>
    [Fact]
    public async Task HomeAssistant_TreatsANonNumericStateAsAGap()
    {
        var steps = Day(3);
        var handler = new Counting(_ =>
            $$"""[[{"entity_id":"sensor.energyflow_grid_energy","state":"unavailable","last_changed":"{{steps[0].ToString("o", CultureInfo.InvariantCulture)}}"}]]""");
        var history = new HomeAssistantHistory(new HttpClient(handler), HassConfigured());

        var series = await history.SeriesAsync(new[] { "grid" }, "energy", steps, CancellationToken.None);

        Assert.All(series, s => Assert.Empty(s));
    }
}
