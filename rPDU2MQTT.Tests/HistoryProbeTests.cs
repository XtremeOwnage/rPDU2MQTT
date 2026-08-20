using System.Net;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Services;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// What "Test history backend" is actually testing.
/// <para>
/// It used to ask Prometheus <c>/-/ready</c> and report a tick. A server can be perfectly ready and refuse
/// every query this bridge sends — which is what happened: the label matcher carried an escape PromQL
/// rejects, every read came back empty for weeks, and the button stayed green throughout. A probe that
/// cannot fail the way the feature fails is decoration.
/// </para>
/// </summary>
public class HistoryProbeTests
{
    /// <summary>Answers each request from a script keyed by a fragment of the URL.</summary>
    private sealed class Canned(params (string Match, HttpStatusCode Code, string Body)[] script) : HttpMessageHandler
    {
        public readonly List<string> Asked = [];

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            var url = request.RequestUri!.ToString();
            Asked.Add(url);
            foreach (var (match, code, body) in script)
                if (url.Contains(match, StringComparison.Ordinal))
                    return Task.FromResult(new HttpResponseMessage(code) { Content = new StringContent(body) });

            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound) { Content = new StringContent("") });
        }
    }

    private static (PrometheusFlowHistory History, Canned Handler) Probe(params (string, HttpStatusCode, string)[] script)
    {
        var cfg = new Config();
        cfg.History.Enabled = true;
        cfg.History.Provider = "prometheus";
        cfg.History.PrometheusUrl = "http://prometheus:9090";
        var handler = new Canned(script);
        return (new PrometheusFlowHistory(new HttpClient(handler), cfg), handler);
    }

    private const string Ready = "-/ready";
    private const string Query = "/api/v1/query";

    [Fact]
    public async Task AReadyServerThatRefusesTheQuery_FailsTheProbe_AndSaysWhy()
    {
        // The live bug, exactly: ready answers 200, the query 400s with the reason.
        var (history, _) = Probe(
            (Ready, HttpStatusCode.OK, "ready"),
            (Query, HttpStatusCode.BadRequest,
             """{"status":"error","errorType":"bad_data","error":"invalid parameter \"query\": parse error: unknown escape sequence U+0023 '#'"}"""));

        var (ok, detail) = await history.ProbeAsync(CancellationToken.None);

        Assert.False(ok);
        Assert.Contains("unknown escape sequence", detail);
    }

    [Fact]
    public async Task TheProbeSendsTheSameMatcherTheReaderSends()
    {
        // Including the punctuation that broke it: a probe on a tidy id would have passed all along.
        var (history, handler) = Probe(
            (Ready, HttpStatusCode.OK, "ready"),
            (Query, HttpStatusCode.OK, """{"status":"success","data":{"resultType":"vector","result":[]}}"""));

        await history.ProbeAsync(CancellationToken.None);

        var matcherQuery = Assert.Single(handler.Asked, u => u.Contains("node%3D~") || u.Contains("node=~"));
        Assert.Contains("%23", matcherQuery);   // '#', url-encoded — the character that was being escaped wrongly
        Assert.Contains("%3A", matcherQuery);   // ':' — every outlet id carries one
    }

    [Fact]
    public async Task AServerHoldingNothingIsHealthy_ButSaysSo()
    {
        // A fresh install has no history yet. That is not a fault, and must not read as one — but it is
        // worth saying, because "reachable" over an empty backend is why a chart is blank.
        var (history, _) = Probe(
            (Ready, HttpStatusCode.OK, "ready"),
            (Query, HttpStatusCode.OK, """{"status":"success","data":{"resultType":"vector","result":[]}}"""));

        var (ok, detail) = await history.ProbeAsync(CancellationToken.None);

        Assert.True(ok);
        Assert.Contains("no flow series stored yet", detail);
    }

    [Fact]
    public async Task AServerHoldingSeriesSaysHowMany()
    {
        var (history, _) = Probe(
            (Ready, HttpStatusCode.OK, "ready"),
            ("count", HttpStatusCode.OK,
             """{"status":"success","data":{"resultType":"vector","result":[{"metric":{},"value":[1786000000,"42"]}]}}"""),
            (Query, HttpStatusCode.OK, """{"status":"success","data":{"resultType":"vector","result":[]}}"""));

        var (ok, detail) = await history.ProbeAsync(CancellationToken.None);

        Assert.True(ok);
        Assert.Contains("42 flow series", detail);
    }

    [Fact]
    public async Task AServerThatIsNotUpFailsBeforeAnythingElse()
    {
        var (history, handler) = Probe((Ready, HttpStatusCode.ServiceUnavailable, "starting"));

        var (ok, detail) = await history.ProbeAsync(CancellationToken.None);

        Assert.False(ok);
        Assert.Contains("503", detail);
        Assert.DoesNotContain(handler.Asked, u => u.Contains("/api/v1/query"));
    }

    [Fact]
    public void TheStatusReaderKeepsPrometheusOwnReason()
    {
        var (ok, error, series) = HistoryParsing.PrometheusStatus(
            """{"status":"error","errorType":"bad_data","error":"1:49: parse error: unknown escape sequence"}""");

        Assert.False(ok);
        Assert.Equal(0, series);
        Assert.Contains("unknown escape sequence", error);
    }
}

/// <summary>
/// The same question for EmonCMS: not "are there feeds" but "are there the feeds a read looks up". The
/// lookup key comes from FlowInputNameTemplate, so changing that template leaves every feed in place and
/// every read empty — a shelf full of data nobody can address.
/// </summary>
public class EmonCmsProbeTests
{
    private sealed class Canned(string body) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
            => Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.OK) { Content = new StringContent(body) });
    }

    private static EmonCmsFlowHistory History(string feedsJson, string template = "{node}_{metric}")
    {
        var cfg = new Config();
        cfg.EmonCMS.Url = "http://emoncms";
        cfg.EmonCMS.ApiKey = "k";
        cfg.EmonCMS.FlowInputNameTemplate = template;
        cfg.EnergyFlow.Nodes.Add(new rPDU2MQTT.Models.Config.EnergyFlowNode { Id = "main_panel" });
        return new EmonCmsFlowHistory(new HttpClient(new Canned(feedsJson)), cfg);
    }

    [Fact]
    public async Task FeedsNamedTheWayAReadLooksThemUp_AreReportedAsFound()
    {
        var history = History("""[{"id":"1","name":"main_panel_realpower"},{"id":"2","name":"grid_realpower"}]""");

        var (ok, detail) = await history.ProbeAsync(CancellationToken.None);

        Assert.True(ok);
        Assert.Contains("main_panel_realpower", detail);
    }

    [Fact]
    public async Task FeedsUnderOtherNames_AreReachableButUseless_AndSaidSo()
    {
        // Every feed present, none addressable: the exact shape of a template changed after provisioning.
        var history = History("""[{"id":"1","name":"panel_power_w"},{"id":"2","name":"grid_power_w"}]""");

        var (ok, detail) = await history.ProbeAsync(CancellationToken.None);

        Assert.True(ok);   // the backend is fine; it is the naming that is not
        Assert.Contains("none named", detail);
        Assert.Contains("main_panel", detail);
    }
}
