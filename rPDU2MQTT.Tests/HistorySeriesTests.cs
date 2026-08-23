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
