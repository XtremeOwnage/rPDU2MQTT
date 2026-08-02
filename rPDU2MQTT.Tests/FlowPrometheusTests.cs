using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Helpers;
using rPDU2MQTT.Models.Config;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// The energy-flow hierarchy reaching Prometheus. Every gauge above it is raised from a PDU reading, so a
/// panel, an inverter or the grid — every tier the hierarchy exists to describe — had no series at all.
/// </summary>
public class FlowPrometheusTests
{
    [Fact]
    public void AFlowTierMetricName_IsDistinctFromTheReadingOne_AndHonoursTheTemplate()
    {
        var cfg = new Config();

        var reading = MetricsHelper.PrometheusMetricName("realpower", "pdu1", "outlet1", "W", cfg);
        var tier = MetricsHelper.PrometheusMetricName("flow_realpower", "", "", "W", cfg);

        Assert.Equal("rpdu2mqtt_realpower", reading);
        Assert.Equal("rpdu2mqtt_flow_realpower", tier);
        Assert.NotEqual(reading, tier);   // sharing a name would mean two label sets on one gauge

        cfg.Prometheus.MetricNameTemplate = "homelab_{type}";
        Assert.Equal("homelab_flow_energytoday", MetricsHelper.PrometheusMetricName($"flow_{EnergyPeriod.Metric}", "", "", "kWh", cfg));
    }

    [Fact]
    public void TheDailyMetric_HasAFriendlyName_ForTheMetricBrowser()
    {
        // The HELP text is what makes a series readable in Grafana without knowing this project's vocabulary.
        Assert.Equal("Energy Today", MetricsHelper.FriendlyTypeName(EnergyPeriod.Metric));
        Assert.Equal("Energy", MetricsHelper.FriendlyTypeName("energy"));
    }

    private sealed class Fixed : IFlowValueSource
    {
        private readonly Dictionary<string, double> v;
        public Fixed(Dictionary<string, double> x) => v = x;
        public bool TryGetValue(string node, string metric, out double value) => v.TryGetValue(node + "|" + metric, out value);
    }

    private static EnergyFlowConfig Topology()
    {
        var c = new EnergyFlowConfig();
        c.Nodes.Add(new EnergyFlowNode { Id = "inverter", Kind = "inverter" });
        c.Nodes.Add(new EnergyFlowNode { Id = "panel", Kind = "panel" });
        c.Links.Add(new EnergyFlowLink { From = "inverter", To = "panel" });
        return c;
    }

    [Fact]
    public void OnlyDeterminedTiers_AreExportable_AndSyntheticOnesNever()
    {
        // What the exporter filters on. Unknown must be absent from the scrape rather than scraped as 0 — a
        // gap in a dashboard is honest, a confident zero is a reading nobody took. Synthetic nodes describe
        // an arithmetic result, not a device, so they are not series either.
        var graph = FlowGraphBuilder.Build(
            new Models.PDU.PduData(), Topology(), "realpower",
            new Fixed(new() { ["inverter|realpower"] = 8299, ["inverter|realpower#in"] = 120 }));

        var exportable = graph.Nodes.Where(n => !n.Synthetic && n.Value is not null).Select(n => n.Id).ToList();

        Assert.Contains("inverter", exportable);
        Assert.All(graph.Nodes.Where(n => n.Synthetic), n => Assert.Contains('#', n.Id));
        Assert.DoesNotContain(exportable, id => id.Contains('#'));
    }

    [Fact]
    public void ATiersParentLabel_IsTheThingThatFeedsIt()
    {
        // The 'tier' label is what lets a dashboard group by where the power came from.
        var graph = FlowGraphBuilder.Build(
            new Models.PDU.PduData(), Topology(), "realpower",
            new Fixed(new() { ["inverter|realpower"] = 8299 }));

        Assert.Equal("inverter", FlowExport.Parents(graph, "panel").FirstOrDefault());
        Assert.Empty(FlowExport.Parents(graph, "inverter"));   // a root has none, and must not invent one
    }
}
