using rPDU2MQTT.Core.Flow;
using Xunit;

using rPDU2MQTT.Integrations.Prometheus;

namespace rPDU2MQTT.Tests;

/// <summary>
/// Reading a whole range in one answer.
///
/// <para>
/// A chart asks about tens or hundreds of moments at once. Asked one at a time — which is all the seam
/// could do — six hours at five-minute resolution is 72 round trips, so anything finer than a day was not
/// a chart but a timeout.
/// </para>
/// </summary>
public class HistoryRangeTests
{
    private static readonly long[] Steps = [1786000000, 1786000300, 1786000600];

    [Fact]
    public void EachSampleLandsOnItsOwnStep()
    {
        const string json = """
        {"status":"success","data":{"resultType":"matrix","result":[
          {"metric":{"node":"solar"},"values":[[1786000000,"4200"],[1786000300,"4400"],[1786000600,"3900"]]},
          {"metric":{"node":"grid"},"values":[[1786000000,"0"],[1786000600,"120"]]}]}}
        """;

        var slots = PrometheusWire.Range(json, Steps);

        Assert.Equal(3, slots.Count);
        Assert.Equal(4200, slots[0]["solar"]);
        Assert.Equal(4400, slots[1]["solar"]);
        Assert.Equal(120, slots[2]["grid"]);
    }

    [Fact]
    public void AStepWithNoSampleStaysEmpty()
    {
        // Never carried forward: a flat line drawn through a gap cannot be told from a reading that
        // genuinely did not change.
        const string json = """
        {"data":{"result":[{"metric":{"node":"grid"},"values":[[1786000000,"5"],[1786000600,"7"]]}]}}
        """;

        var slots = PrometheusWire.Range(json, Steps);

        Assert.False(slots[1].ContainsKey("grid"));
        Assert.Equal(5, slots[0]["grid"]);
        Assert.Equal(7, slots[2]["grid"]);
    }

    [Fact]
    public void ASampleOffTheBoundaryIsStillPlaced()
    {
        // A server clock or a rounded start lands a sample a second either side of the step it belongs to.
        const string json = """
        {"data":{"result":[{"metric":{"node":"solar"},"values":[[1786000301,"4400"]]}]}}
        """;

        Assert.Equal(4400, PrometheusWire.Range(json, Steps)[1]["solar"]);
    }

    [Fact]
    public void SamplesOutsideTheWindowAreDropped()
    {
        const string json = """
        {"data":{"result":[{"metric":{"node":"solar"},"values":[[1700000000,"1"],[1900000000,"2"]]}]}}
        """;

        Assert.All(PrometheusWire.Range(json, Steps), slot => Assert.Empty(slot));
    }

    [Theory]
    [InlineData("NaN")]
    [InlineData("+Inf")]
    public void NonFiniteSamplesAreNotReadings(string sample)
    {
        var json = """{"data":{"result":[{"metric":{"node":"solar"},"values":[[1786000000,"S"]]}]}}"""
            .Replace("S", sample);

        Assert.Empty(PrometheusWire.Range(json, Steps)[0]);
    }

    [Fact]
    public void ABrokenOrEmptyAnswerIsNoHistory_NotACrash()
    {
        Assert.All(PrometheusWire.Range("not json", Steps), slot => Assert.Empty(slot));
        Assert.All(PrometheusWire.Range("""{"status":"error"}""", Steps), slot => Assert.Empty(slot));
        Assert.Empty(PrometheusWire.Range("""{"data":{"result":[]}}""", []));
    }

    [Fact]
    public void ASeriesWithNoNodeLabelIsIgnored()
    {
        const string json = """{"data":{"result":[{"metric":{"job":"x"},"values":[[1786000000,"5"]]}]}}""";
        Assert.All(PrometheusWire.Range(json, Steps), slot => Assert.Empty(slot));
    }

    private sealed class OneAtATime : IMeasurementHistory
    {
        public int Calls;
        public string Id => "test";
        public Task<(bool Ok, string Detail)> ProbeAsync(CancellationToken ct) => Task.FromResult((true, ""));
        public Task<IReadOnlyDictionary<string, double>> ValuesAtAsync(
            IReadOnlyCollection<string> nodeIds, string metric, DateTime atUtc, CancellationToken ct)
        {
            Calls++;
            return Task.FromResult<IReadOnlyDictionary<string, double>>(
                new Dictionary<string, double> { ["solar"] = atUtc.Minute });
        }
    }

    [Fact]
    public async Task ABackendWithNoRangeSupportStillAnswers()
    {
        // The default keeps the seam honest for a backend that cannot do better — it just costs a request
        // per step, which is why the one that can, does.
        var backend = new OneAtATime();
        DateTime[] steps = [new(2026, 8, 8, 12, 0, 0, DateTimeKind.Utc), new(2026, 8, 8, 12, 5, 0, DateTimeKind.Utc)];

        var slots = await ((IMeasurementHistory)backend).SeriesAsync(["solar"], "realpower", steps, default);

        Assert.Equal(2, slots.Count);
        Assert.Equal(0, slots[0]["solar"]);
        Assert.Equal(5, slots[1]["solar"]);
        Assert.Equal(2, backend.Calls);
    }
}
