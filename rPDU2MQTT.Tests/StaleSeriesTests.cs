using Prometheus;
using rPDU2MQTT.Services;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// A Prometheus gauge remembers every label set it has ever been given and serves each one's last value
/// forever. Nothing ages out, so a series whose subject disappeared keeps being scraped as if it were live.
/// </summary>
public class StaleSeriesTests
{
    private static Gauge NewGauge(string name) =>
        Metrics.WithCustomRegistry(Metrics.NewCustomRegistry())
               .CreateGauge(name, "test", "node", "name", "kind", "tier");

    [Fact]
    public void ASeriesNotWrittenThisPass_IsRemoved()
    {
        // The live symptom: the inverter appeared twice in one scrape — 82.6 and 67.1 kWh — because its
        // `tier` label changed and the old combination stayed behind frozen.
        var g = NewGauge("test_flow_a");
        g.WithLabels("inv", "Inverter", "inverter", "Solar (PV)").Set(82.6);
        g.WithLabels("inv", "Inverter", "inverter", "MPPT_1").Set(67.1);
        Assert.Equal(2, g.GetAllLabelValues().Count());

        var written = new HashSet<string>(System.StringComparer.Ordinal)
        {
            PrometheusExportService.LabelKey(new[] { "inv", "Inverter", "inverter", "MPPT_1" }),
        };
        PrometheusExportService.Prune(g, written);

        var left = g.GetAllLabelValues().ToList();
        Assert.Single(left);
        Assert.Equal("MPPT_1", left[0][3]);
    }

    [Fact]
    public void EverythingStillReported_SurvivesUntouched()
    {
        var g = NewGauge("test_flow_b");
        g.WithLabels("a", "A", "node", "").Set(1);
        g.WithLabels("b", "B", "node", "").Set(2);

        var written = new HashSet<string>(System.StringComparer.Ordinal)
        {
            PrometheusExportService.LabelKey(new[] { "a", "A", "node", "" }),
            PrometheusExportService.LabelKey(new[] { "b", "B", "node", "" }),
        };
        PrometheusExportService.Prune(g, written);

        Assert.Equal(2, g.GetAllLabelValues().Count());
    }

    [Fact]
    public void AnEmptyPass_ClearsEverything()
    {
        // Every node going unknown at once is a real state (the feed died); the scrape must then be empty
        // rather than a full set of frozen values.
        var g = NewGauge("test_flow_c");
        g.WithLabels("a", "A", "node", "").Set(1);

        PrometheusExportService.Prune(g, new HashSet<string>(System.StringComparer.Ordinal));

        Assert.Empty(g.GetAllLabelValues());
    }

    [Fact]
    public void LabelSetsThatDifferOnlyByBoundary_DoNotCollide()
    {
        // The key is a join, so a naive separator could make {"a|b","c"} and {"a","b|c"} the same string.
        var one = PrometheusExportService.LabelKey(new[] { "a|b", "c" });
        var two = PrometheusExportService.LabelKey(new[] { "a", "b|c" });
        Assert.NotEqual(one, two);
    }
}
