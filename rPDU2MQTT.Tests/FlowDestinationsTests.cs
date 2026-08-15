using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.EmonCms;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Helpers;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Models.PDU;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// The energy-flow hierarchy reaching the destinations that record it. Prometheus had it, EmonCMS never
/// did — so a modelled hierarchy had a live diagram, no series, and a history page that could only ever
/// answer "no data" for every node above a PDU.
/// </summary>
public class FlowDestinationsTests
{
    private sealed class Fixed : IFlowValueSource
    {
        private readonly Dictionary<string, double> v;
        public Fixed(Dictionary<string, double> x) => v = x;
        public bool TryGetValue(string node, string metric, out double value) => v.TryGetValue(node + "|" + metric, out value);
    }

    private static EnergyFlowConfig Topology()
    {
        var c = new EnergyFlowConfig();
        c.Nodes.Add(new EnergyFlowNode { Id = "solar", Label = "Solar", Kind = "solar", Tags = ["roof"] });
        c.Nodes.Add(new EnergyFlowNode { Id = "inverter", Label = "Inverter", Kind = "inverter" });
        c.Links.Add(new EnergyFlowLink { From = "solar", To = "inverter" });
        return c;
    }

    private static Config Configured()
    {
        var c = new Config();
        c.EnergyFlow = Topology();
        return c;
    }

    private static IFlowValueSource Live() => new Fixed(new()
    {
        ["solar|realpower"] = 4200,
        ["solar|energy"] = 812.5,
        ["solar|energytoday"] = 31.5,
    });

    [Fact]
    public void EveryDestination_ExportsTheSameTiers_UnderTheSameMetrics()
    {
        var cfg = Configured();
        var graphs = FlowTiers.Graphs(new PduData(), cfg, Live());

        Assert.Equal(new[] { "realpower", "energy", EnergyPeriod.Metric }, graphs.Select(g => g.Metric).ToArray());

        var power = FlowTiers.Of(graphs[0].Graph, null).Select(t => t.Node.Id).ToList();
        Assert.Contains("solar", power);
        Assert.Contains("inverter", power);
    }

    [Fact]
    public void ATiersEmonCmsInputName_IsWhatTheHistoryLooksTheFeedUpBy()
    {
        // These two are what makes an EmonCMS-backed history work at all: the export writes the input (and
        // its storage feed) under one name, and the reader finds the feed by that name. They drifted before
        // only because nothing wrote the input at all.
        var cfg = Configured();

        Assert.Equal("solar_realpower", MetricsHelper.EmonCmsFlowInputName("solar", "Solar", "solar", "realpower", cfg));
        Assert.Equal("solar_energytoday", MetricsHelper.EmonCmsFlowInputName("solar", "Solar", "solar", EnergyPeriod.Metric, cfg));
        // An auto node's id carries separators EmonCMS will not take in a key.
        Assert.Equal("outlet_rack_pdu_1_4_energy", MetricsHelper.EmonCmsFlowInputName("outlet:rack_pdu_1:4", "Outlet 5", "outlet", "energy", cfg));
    }

    [Fact]
    public void ThePrometheusFlowMetricName_IsOneSpelling_ForTheExportAndTheHistory()
    {
        var cfg = Configured();
        Assert.Equal("rpdu2mqtt_flow_energytoday", MetricsHelper.PrometheusFlowMetricName(EnergyPeriod.Metric, cfg));

        // A template naming the units used to change the exported name and not the queried one, so every
        // lookup missed. Whatever the template, both sides now ask the same function.
        cfg.Prometheus.MetricNameTemplate = "homelab_{type}_{units}";
        Assert.Equal(
            MetricsHelper.PrometheusFlowMetricName("realpower", cfg),
            MetricsHelper.PrometheusFlowMetricName("realpower", cfg));
        Assert.StartsWith("homelab_flow_realpower", MetricsHelper.PrometheusFlowMetricName("realpower", cfg));
    }

    [Fact]
    public void TheFeedPlanner_ProvisionsAFeedPerTier_NamedAsTheExportWritesIt()
    {
        var cfg = Configured();
        cfg.EmonCMS.Feeds.AutoConfigure = true;
        cfg.EmonCMS.Feeds.Types = [new() { Type = "realpower" }, new() { Type = EnergyPeriod.Metric }];

        var desired = EmonCmsFeedPlanner.BuildDesired(new PduData(), cfg, FlowTiers.Graphs(new PduData(), cfg, Live()));

        Assert.Contains(desired.Feeds, f => f.Name == "solar_realpower");
        Assert.Contains(desired.Feeds, f => f.Name == "solar_energytoday");
        Assert.Contains(desired.Inputs, i => i.InputName == "solar_realpower" && i.StorageFeed == "solar_realpower");
        // A type nobody asked for gets no feed, exactly as for a PDU reading.
        Assert.DoesNotContain(desired.Feeds, f => f.Name == "solar_energy");
    }

    [Fact]
    public void ATagFilter_DecidesWhatEachDestinationCarries_AndNothingElse()
    {
        var cfg = Configured();
        var graph = FlowTiers.Graphs(new PduData(), cfg, Live())[0].Graph;

        var excluded = FlowTiers.Of(graph, new NodeTagFilter { Exclude = ["roof"] }).Select(t => t.Node.Id).ToList();
        Assert.DoesNotContain("solar", excluded);
        Assert.Contains("inverter", excluded);   // untagged, and the exclusion says nothing about it

        // The value itself is untouched — a filter chooses recipients, never readings.
        Assert.Equal(4200, FlowTiers.Of(graph, null).Single(t => t.Node.Id == "solar").Value);
    }

    [Fact]
    public void AStaticWattFigure_IsNotAlsoReportedAsEnergy()
    {
        // Value is a power figure. Applied to every graph it published a 5000 W node as 5000 kWh used, and
        // 5000 kWh used today — into Prometheus, into EmonCMS, and into the history read back from them.
        var flow = new EnergyFlowConfig();
        flow.Nodes.Add(new EnergyFlowNode { Id = "house", Label = "House", Kind = "load", Mode = "static", Value = 5000 });

        var power = FlowGraphBuilder.Build(new PduData(), flow, FlowGraphBuilder.DefaultMetric);
        var energy = FlowGraphBuilder.Build(new PduData(), flow, "energy");
        var today = FlowGraphBuilder.Build(new PduData(), flow, EnergyPeriod.Metric);

        Assert.Equal(5000, power.Nodes.Single(n => n.Id == "house").Value);
        Assert.Null(energy.Nodes.SingleOrDefault(n => n.Id == "house")?.Value);
        Assert.Null(today.Nodes.SingleOrDefault(n => n.Id == "house")?.Value);
    }

    [Fact]
    public void AHierarchyOfVirtualNodesAlone_IsStillSomethingToExport()
    {
        // An install can be all inverter and battery and no PDU at all; the exports used to require one.
        Assert.True(FlowTiers.Any(new PduData(), Configured()));
        Assert.False(FlowTiers.Any(new PduData(), new Config()));
    }
}
