using rPDU2MQTT.Core.Flow;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// Reading a history backend's answer (#372). A value the backend does not have must be absent, not zero:
/// the builder reads absent as unmeasured and says so, while a zero is a reading nobody took.
/// </summary>
public class FlowHistoryTests
{
    // --- Prometheus ------------------------------------------------------------------------------------

    [Fact]
    public void PrometheusInstant_ReadsAValuePerNode()
    {
        const string json = """
        {"status":"success","data":{"resultType":"vector","result":[
          {"metric":{"__name__":"rpdu2mqtt_flow_realpower","node":"grid"},"value":[1786000000,"7080"]},
          {"metric":{"__name__":"rpdu2mqtt_flow_realpower","node":"fridge"},"value":[1786000000,"94.6"]}]}}
        """;

        var values = HistoryParsing.PrometheusInstant(json);

        Assert.Equal(2, values.Count);
        Assert.Equal(7080, values["grid"]);
        Assert.Equal(94.6, values["fridge"]);
    }

    [Theory]
    [InlineData("NaN")]
    [InlineData("+Inf")]
    [InlineData("-Inf")]
    public void PrometheusInstant_DropsNonFiniteSamples(string sample)
    {
        // Prometheus renders staleness and division results in the same field a number appears in, and
        // either would enter the roll-up as a figure.
        var json = """{"data":{"result":[{"metric":{"node":"grid"},"value":[1786000000,"SAMPLE"]}]}}"""
            .Replace("SAMPLE", sample);

        Assert.Empty(HistoryParsing.PrometheusInstant(json));
    }

    [Fact]
    public void PrometheusInstant_SurvivesAnEmptyOrBrokenAnswer()
    {
        Assert.Empty(HistoryParsing.PrometheusInstant("""{"status":"success","data":{"result":[]}}"""));
        Assert.Empty(HistoryParsing.PrometheusInstant("""{"status":"error","error":"bad query"}"""));
        Assert.Empty(HistoryParsing.PrometheusInstant("not json"));
    }

    [Fact]
    public void PrometheusInstant_IgnoresASeriesWithNoNodeLabel()
    {
        // Another exporter's series can match a hand-edited metric name; without a node label there is
        // nothing to attribute it to.
        Assert.Empty(HistoryParsing.PrometheusInstant("""{"data":{"result":[{"metric":{"job":"x"},"value":[1,"5"]}]}}"""));
    }

    [Fact]
    public void TheQueryCollapsesEveryProcessThatReportedANode()
    {
        // The exporter's series carry an `instance` label, so every restart or reschedule of the bridge
        // starts a fresh series for the same node. A bare selector returns all of them and the reader took
        // whichever the answer happened to list last — on the cluster this was found on, eighteen
        // instances in a day.
        var query = HistoryParsing.NodeQuery("rpdu2mqtt_flow_energytoday", ["solar", "grid"]);

        Assert.StartsWith("max by (node) (", query);
        Assert.Contains("rpdu2mqtt_flow_energytoday{node=~", query);
        Assert.Contains("solar", query);
    }

    [Fact]
    public void SeveralSeriesForOneNodeStillYieldOneValue()
    {
        // What the reader must make of an uncollapsed answer: one entry per node, never two.
        var json = "{\"data\":{\"result\":["
                 + "{\"metric\":{\"node\":\"solar\"},\"value\":[1786000000,\"62\"]},"
                 + "{\"metric\":{\"node\":\"solar\"},\"value\":[1786000000,\"33\"]}]}}";

        var values = HistoryParsing.PrometheusInstant(json);

        Assert.Single(values);
    }

    [Fact]
    public void NodeMatcher_EscapesIdsSoOneNodeCannotMatchAnother()
    {
        // A '.' or '|' left unescaped widens the match to other nodes. The backslash is DOUBLED because
        // PromQL reads this as a string first and hands what survives to the pattern.
        var matcher = HistoryParsing.NodeMatcher(["outlet:pdu_1:4", "a.b", "c|d"]);

        Assert.Contains(@"a\\.b", matcher);
        Assert.DoesNotContain("a.b|", matcher);
        Assert.Contains(@"c\\|d", matcher);
    }

    [Fact]
    public void NodeMatcher_LeavesTheCharactersNodeIdsActuallyContain_Alone()
    {
        // The bug this exists for: '#' is ordinary text to RE2, and PromQL rejects "\#" as an unknown
        // escape — so a single return-lane id in the list failed the whole query with an HTTP 400, and
        // every node's history came back empty. ':' is the same kind of character, in every outlet id.
        var matcher = HistoryParsing.NodeMatcher(["grid#in", "outlet:pdu_1:4", "eg4-flexboss21-battery#in"]);

        Assert.Equal("grid#in|outlet:pdu_1:4|eg4-flexboss21-battery#in", matcher);
    }

    [Fact]
    public void NodeQuery_CarriesNoEscapePromqlWillRefuse()
    {
        // PromQL's string escapes are Go's: a lone backslash before anything but " \ n r t etc. is a parse
        // error. Every backslash we emit must therefore be part of a pair.
        var query = HistoryParsing.NodeQuery("rpdu2mqtt_flow_energytoday",
            ["grid#in", "outlet:pdu_1:4", "a.b", "solar"]);

        for (var i = 0; i < query.Length; i++)
        {
            if (query[i] != '\\') continue;
            Assert.True(i + 1 < query.Length && query[i + 1] == '\\',
                $"lone backslash at {i} in: {query}");
            i++;   // step over the pair
        }

        Assert.DoesNotContain(@"\#", query);
    }

    // --- EmonCMS ---------------------------------------------------------------------------------------

    [Fact]
    public void EmonCmsFeeds_MapsNameToId()
    {
        const string json = """[{"id":"12","name":"fridge_realpower"},{"id":13,"name":"grid"}]""";

        var feeds = HistoryParsing.EmonCmsFeeds(json);

        Assert.Equal("12", feeds["fridge_realpower"]);
        Assert.Equal("13", feeds["grid"]);
    }

    [Fact]
    public void EmonCmsPointAt_TakesTheLastPointAtOrBeforeTheMoment()
    {
        const string json = "[[1000,5.0],[2000,6.0],[3000,7.0]]";

        Assert.Equal(6.0, HistoryParsing.EmonCmsPointAt(json, 2500));
        Assert.Equal(7.0, HistoryParsing.EmonCmsPointAt(json, 9999));
        Assert.Null(HistoryParsing.EmonCmsPointAt(json, 500));   // nothing that early
    }

    [Fact]
    public void EmonCmsPointAt_SkipsGaps()
    {
        // EmonCMS records a gap as a null in the same array as real points. Taking the last element
        // regardless would report the gap as a reading.
        Assert.Equal(6.0, HistoryParsing.EmonCmsPointAt("[[1000,5.0],[2000,6.0],[3000,null]]", 9999));
        Assert.Null(HistoryParsing.EmonCmsPointAt("[[1000,null]]", 9999));
        Assert.Null(HistoryParsing.EmonCmsPointAt("[]", 9999));
        Assert.Null(HistoryParsing.EmonCmsPointAt("not json", 9999));
    }

    // --- The seam --------------------------------------------------------------------------------------

    [Fact]
    public void HistoricalSource_AnswersOnlyTheMetricItHolds()
    {
        // Answering a different metric would hand the power roll-up an energy figure.
        var src = new HistoricalFlowValueSource(new Dictionary<string, double> { ["grid"] = 7080 }, "realpower");

        Assert.True(src.TryGetValue("grid", "realpower", out var w));
        Assert.Equal(7080, w);
        Assert.False(src.TryGetValue("grid", "energy", out _));
        Assert.False(src.TryGetValue("solar", "realpower", out _));
    }

    [Fact]
    public void AHistoricalGraphIsBuiltByTheSameRules()
    {
        // The point of the seam: history is values, not a second rendering path. A node the backend has
        // nothing for is unmeasured, exactly as a node with no source is now.
        var flow = new rPDU2MQTT.Models.Config.EnergyFlowConfig();
        flow.Nodes.Add(new rPDU2MQTT.Models.Config.EnergyFlowNode { Id = "grid" });
        flow.Nodes.Add(new rPDU2MQTT.Models.Config.EnergyFlowNode { Id = "panel" });
        flow.Links.Add(new rPDU2MQTT.Models.Config.EnergyFlowLink { From = "grid", To = "panel" });

        var past = new HistoricalFlowValueSource(new Dictionary<string, double> { ["grid"] = 7080 }, "realpower");
        var graph = FlowGraphBuilder.Build(new rPDU2MQTT.Models.PDU.PduData(), flow, "realpower", past);

        Assert.Equal(7080, graph.Nodes.Single(n => n.Id == "grid").Value);
        Assert.Equal(FlowDerivation.Measured, graph.Nodes.Single(n => n.Id == "grid").Derivation);
    }
}
