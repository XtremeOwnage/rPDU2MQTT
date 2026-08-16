using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.EmonCms;
using rPDU2MQTT.Core;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Core.Integrations;
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

    // --- Node identity ---------------------------------------------------------------------------------

    [Fact]
    public void AReadingKnowsItsNode_AndAgreesWithTheGraph()
    {
        // Eight places built these ids by hand and two disagreed about the outlet index: the graph keys on
        // the 0-based outlet.Key, a reading carries the 1-based Number. Nothing errors when they diverge —
        // the lookup misses and a hierarchy label silently comes back empty.
        var data = OneOutlet(60);
        var reading = MetricsHelper.EnumerateReadings(data).Single(r => r.Type == "realpower");

        Assert.Equal("outlet:rack_pdu_1:0", reading.NodeId);
        Assert.Equal(1, reading.Number);            // 1-based on the reading...
        Assert.Equal(FlowNodeId.ForOutletNumber("rack_pdu_1", reading.Number!.Value), reading.NodeId);

        // ...and the graph names the same node the same way.
        var graph = FlowGraphBuilder.Build(data, new EnergyFlowConfig(), "realpower");
        Assert.Contains(graph.Nodes, n => n.Id == reading.NodeId);
    }

    [Fact]
    public void ADeviceLevelReading_BelongsToThePduTier_NotAnOutlet()
    {
        var data = OneOutlet(60);
        data.Devices[0].Entity.Add(new Entity { Entity_Name = "total", Entity_DisplayName = "Total" });
        data.Devices[0].Entity[0].Measurements.Add(new Measurement { Type = "realpower", Value = "60", Units = "W" });

        var reading = MetricsHelper.EnumerateReadings(data).Single(r => r.Source == "total");

        Assert.Equal("pdu:rack_pdu_1", reading.NodeId);
        Assert.Null(reading.Number);
    }

    // --- What EmonCMS is actually sent -----------------------------------------------------------------
    // Everything above tests the graph. The graph was never the problem: the flow half of the EmonCMS
    // payload did not exist, and no graph test could notice. These hold the payload itself, so deleting the
    // flow lines from the export fails here rather than in someone's dashboard six weeks later.

    private static PduData OneOutlet(double watts)
    {
        var outlet = new Outlet { Key = 0, Entity_Name = "o0", Entity_DisplayName = "Server A" };
        outlet.Measurements.Add(new Measurement { Type = "realpower", Value = watts.ToString(), Units = "W" });
        var device = new Device { Key = "pdu1", Entity_Name = "rack_pdu_1", Entity_DisplayName = "Rack PDU 1" };
        device.Outlets.Add(outlet);
        var data = new PduData();
        data.Devices.Add(device);
        return data;
    }

    /// The pass the destination host would assemble, so a test exercises the real path rather than a
    /// parallel one — the mistake that let the flow half go missing in the first place.
    private static ExportPass Pass(Config cfg, params PduData[] snapshots)
        => ExportPass.Build(snapshots.Select(d => new PduSnapshot("default", DateTime.UtcNow, d)), cfg, Live());

    private static Dictionary<string, double> Sent(Config cfg, params PduData[] snapshots)
        => EmonCmsPayload.Build(Pass(cfg, snapshots), cfg)[EmonCmsPayload.Combined];

    [Fact]
    public void TheEmonCmsPayload_CarriesEveryFlowNode_AlongsideThePduReadings()
    {
        var sent = Sent(Configured(), OneOutlet(60));

        // The PDU half, which always worked.
        Assert.Equal(60, sent["rack_pdu_1_o0_realpower"]);
        // The half that never existed. Every tier, under every metric it has a value for.
        Assert.Equal(4200, sent["solar_realpower"]);
        Assert.Equal(812.5, sent["solar_energy"]);
        Assert.Equal(31.5, sent["solar_energytoday"]);
        Assert.Equal(4200, sent["inverter_realpower"]);
    }

    [Fact]
    public void AFlowNodeLeavesThePayload_OnlyWhenItsTagIsExcluded()
    {
        var cfg = Configured();
        Assert.Contains("solar_realpower", Sent(cfg).Keys);

        // 'solar' carries 'roof'; 'inverter' carries nothing and is unaffected by an exclusion.
        cfg.EmonCMS.NodeTags.Exclude = ["roof"];
        var filtered = Sent(cfg);
        Assert.DoesNotContain("solar_realpower", filtered.Keys);
        Assert.Contains("inverter_realpower", filtered.Keys);

        // And an include list narrows to exactly what it names.
        cfg.EmonCMS.NodeTags.Exclude = [];
        cfg.EmonCMS.NodeTags.Include = ["roof"];
        var included = Sent(cfg);
        Assert.Contains("solar_realpower", included.Keys);
        Assert.DoesNotContain("inverter_realpower", included.Keys);
    }

    [Fact]
    public void ThePduReadingsAreNeverWithheld_ByAFlowTagFilter()
    {
        // A filter chooses which *hierarchy nodes* a destination carries. It has never had anything to say
        // about a PDU measurement, and a filter that quietly stopped those would be a far worse bug.
        var cfg = Configured();
        cfg.EmonCMS.NodeTags.Include = ["nothing-carries-this"];

        Assert.Equal(60, Sent(cfg, OneOutlet(60))["rack_pdu_1_o0_realpower"]);
    }

    [Fact]
    public void TurningTheFlowExportOff_IsTheOnlyOtherWayItGoesQuiet()
    {
        var cfg = Configured();
        cfg.EmonCMS.ExportFlowNodes = false;

        var sent = Sent(cfg, OneOutlet(60));
        Assert.Equal(60, sent["rack_pdu_1_o0_realpower"]);
        Assert.DoesNotContain(sent.Keys, k => k.StartsWith("solar_"));
    }

    [Fact]
    public void SplittingThePayloadPerPdu_StillCarriesTheHierarchy()
    {
        // A tier belongs to no device, so a per-device split has nowhere to file it — it must not be the
        // thing that drops it.
        var cfg = Configured();
        cfg.EmonCMS.Transport = EmonCmsTransport.Mqtt;
        cfg.EmonCMS.MqttTopicTemplate = "{base}/{node}/{device}";

        var payloads = EmonCmsPayload.Build(Pass(cfg, OneOutlet(60)), cfg);

        Assert.Equal(60, payloads["rack_pdu_1"]["rack_pdu_1_o0_realpower"]);
        Assert.Equal(4200, payloads[EmonCmsPayload.Combined]["solar_realpower"]);
    }
}
