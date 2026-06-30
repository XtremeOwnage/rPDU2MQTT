using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Models.PDU;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>FlowGraphBuilder: auto-derive a PDU -> outlet power-flow graph from a snapshot (#97).</summary>
public class FlowGraphTests
{
    private static Outlet Outlet(int key, string name, string type, string value, string units = "W")
    {
        var o = new Outlet { Key = key, Entity_Name = $"o{key}", Entity_DisplayName = name };
        o.Measurements.Add(new Measurement { Type = type, Value = value, Units = units });
        return o;
    }

    private static PduData OnePdu(params Outlet[] outlets)
    {
        var device = new Device { Key = "pdu1", Entity_Name = "pdu1", Entity_DisplayName = "PDU 1" };
        device.Outlets.AddRange(outlets);
        var data = new PduData();
        data.Devices.Add(device);
        return data;
    }

    [Fact]
    public void Build_LinksOutletsToTheirPdu_WeightedByRealpower()
    {
        var graph = FlowGraphBuilder.Build(OnePdu(
            Outlet(0, "Outlet 1", "realpower", "100"),
            Outlet(1, "Outlet 2", "realpower", "50")));

        Assert.Equal("realpower", graph.Metric);
        Assert.Equal("W", graph.Units);
        Assert.Contains(graph.Nodes, n => n.Id == "pdu:pdu1" && n.Kind == "pdu");
        Assert.Equal(2, graph.Nodes.Count(n => n.Kind == "outlet"));
        Assert.Equal(100, graph.Links.Single(l => l.Target == "outlet:pdu1:0").Value);
        Assert.All(graph.Links, l => Assert.Equal("pdu:pdu1", l.Source));
    }

    [Fact]
    public void Build_SkipsZeroAndNonMatchingMeasurements()
    {
        var graph = FlowGraphBuilder.Build(OnePdu(
            Outlet(0, "Active", "realpower", "30"),
            Outlet(1, "Idle", "realpower", "0"),          // no flow -> skipped
            Outlet(2, "OtherMetric", "current", "2.5")));  // not the requested metric -> skipped

        Assert.Single(graph.Links);
        Assert.Equal("outlet:pdu1:0", graph.Links[0].Target);
        Assert.DoesNotContain(graph.Nodes, n => n.Id == "outlet:pdu1:1");
    }

    [Fact]
    public void Build_OmitsPdusWithNoMeasuredFlow()
    {
        var graph = FlowGraphBuilder.Build(OnePdu(Outlet(0, "Idle", "realpower", "0")));
        Assert.Empty(graph.Nodes);
        Assert.Empty(graph.Links);
    }

    [Fact]
    public void Build_MergesCustomHierarchy_AndPropagatesValuesUp()
    {
        var data = OnePdu(Outlet(0, "A", "realpower", "60"), Outlet(1, "B", "realpower", "40"));
        var flow = new EnergyFlowConfig
        {
            Nodes = { new EnergyFlowNode { Id = "total", Label = "Total" }, new EnergyFlowNode { Id = "breaker", Label = "Breaker 15" } },
            // outlets -> PDU (auto); PDU -> breaker -> total (custom). Energy flows parent -> child.
            Parents = { ["pdu:pdu1"] = "breaker", ["breaker"] = "total" },
        };

        var graph = FlowGraphBuilder.Build(data, flow);

        // The custom upstream links carry the aggregated downstream power (60 + 40 = 100).
        Assert.Equal(100, graph.Links.Single(l => l.Source == "total" && l.Target == "breaker").Value);
        Assert.Equal(100, graph.Links.Single(l => l.Source == "breaker" && l.Target == "pdu:pdu1").Value);
        Assert.Equal(60, graph.Links.Single(l => l.Target == "outlet:pdu1:0").Value);
        Assert.Contains(graph.Nodes, n => n.Id == "total" && n.Label == "Total");
    }

    [Fact]
    public void Build_UsesManualLeafValueForSensorlessNodes_AndAggregatesWithPduFlow()
    {
        // A panel fed by the PDU (60W of outlets) plus an untracked-but-known 40W load, under "Total".
        var data = OnePdu(Outlet(0, "Server", "realpower", "60"));
        var flow = new EnergyFlowConfig
        {
            Nodes =
            {
                new EnergyFlowNode { Id = "total", Label = "Panel" },
                new EnergyFlowNode { Id = "lights", Label = "Lights (known)", Value = 40 },
            },
            Parents = { ["pdu:pdu1"] = "total", ["lights"] = "total" },
        };

        var graph = FlowGraphBuilder.Build(data, flow);

        Assert.Equal(40, graph.Links.Single(l => l.Target == "lights").Value);   // manual leaf value
        Assert.Equal(100, graph.Links.Single(l => l.Target == "pdu:pdu1").Value + graph.Links.Single(l => l.Target == "lights").Value);
    }

    [Fact]
    public void Build_ExplicitParentOverridesAutoPduLink_OneFeederPerNode()
    {
        // Reparenting an outlet onto a custom breaker must suppress its auto PDU->outlet link,
        // so the outlet ends up with exactly one feeder (the bug: it had both).
        var data = OnePdu(Outlet(0, "Server", "realpower", "60"));
        var flow = new EnergyFlowConfig
        {
            Nodes = { new EnergyFlowNode { Id = "breaker", Label = "Breaker 15" } },
            Parents = { ["outlet:pdu1:0"] = "breaker" },
        };

        var graph = FlowGraphBuilder.Build(data, flow);

        Assert.DoesNotContain(graph.Links, l => l.Source == "pdu:pdu1" && l.Target == "outlet:pdu1:0");
        Assert.Equal(60, graph.Links.Single(l => l.Source == "breaker" && l.Target == "outlet:pdu1:0").Value);
        Assert.Single(graph.Links, l => l.Target == "outlet:pdu1:0");
    }

    [Fact]
    public void Build_IgnoresParentLinksToUnknownNodes()
    {
        var data = OnePdu(Outlet(0, "A", "realpower", "10"));
        var flow = new EnergyFlowConfig { Parents = { ["pdu:pdu1"] = "ghost" } }; // 'ghost' has no node def
        var graph = FlowGraphBuilder.Build(data, flow);

        Assert.DoesNotContain(graph.Nodes, n => n.Id == "ghost");
        Assert.DoesNotContain(graph.Links, l => l.Source == "ghost");
    }

    [Fact]
    public void Build_DirectedLinks_AllowMultipleFeedersIntoOneNode()
    {
        // A transfer switch ("gridboss") fed by both grid and generator, then feeding the PDU.
        var data = OnePdu(Outlet(0, "Server", "realpower", "100"));
        var flow = new EnergyFlowConfig
        {
            Nodes =
            {
                new EnergyFlowNode { Id = "gridboss", Label = "Grid Boss" },
                new EnergyFlowNode { Id = "grid", Label = "Grid", Value = 70 },
                new EnergyFlowNode { Id = "gen", Label = "Generator", Value = 30 },
            },
            Links =
            {
                new EnergyFlowLink { From = "gridboss", To = "pdu:pdu1" }, // gridboss powers the PDU (demand-driven)
                new EnergyFlowLink { From = "grid", To = "gridboss" },     // two feeders into one node
                new EnergyFlowLink { From = "gen", To = "gridboss" },
            },
        };

        var graph = FlowGraphBuilder.Build(data, flow);

        Assert.Equal(2, graph.Links.Count(l => l.Target == "gridboss")); // multi-parent
        Assert.Equal(70, graph.Links.Single(l => l.Source == "grid").Value);  // measured producer values
        Assert.Equal(30, graph.Links.Single(l => l.Source == "gen").Value);
        Assert.Equal(100, graph.Links.Single(l => l.Source == "gridboss").Value); // demand-driven downstream
    }

    [Fact]
    public void Build_ProducerLink_CarriesGenerationIntoWhatItFeeds()
    {
        // Solar (a producer with a known value) feeds the PDU's upstream node; the link width is the generation.
        var data = OnePdu(Outlet(0, "Load", "realpower", "20"));
        var flow = new EnergyFlowConfig
        {
            Nodes = { new EnergyFlowNode { Id = "solar", Label = "Solar", Value = 500 } },
            Links = { new EnergyFlowLink { From = "solar", To = "pdu:pdu1" } },
        };

        var graph = FlowGraphBuilder.Build(data, flow);

        Assert.Equal(500, graph.Links.Single(l => l.Source == "solar" && l.Target == "pdu:pdu1").Value);
        Assert.Contains(graph.Nodes, n => n.Id == "solar" && n.Label == "Solar");
    }

    [Fact]
    public void Build_ProducerFeedingMultipleConsumers_SplitsGenerationByDemand()
    {
        // Solar powers two PDUs drawing 100W and 300W. Its 800W generation must split 1:3 across the two
        // links (200 / 600), not show 800 on each — i.e. the producer isn't counted once per consumer.
        var d1 = new Device { Key = "pdu1", Entity_Name = "pdu1", Entity_DisplayName = "PDU 1" };
        d1.Outlets.Add(Outlet(0, "LoadA", "realpower", "100"));
        var d2 = new Device { Key = "pdu2", Entity_Name = "pdu2", Entity_DisplayName = "PDU 2" };
        d2.Outlets.Add(Outlet(0, "LoadB", "realpower", "300"));
        var data = new PduData();
        data.Devices.Add(d1);
        data.Devices.Add(d2);

        var flow = new EnergyFlowConfig
        {
            Nodes = { new EnergyFlowNode { Id = "solar", Label = "Solar", Value = 800 } },
            Links =
            {
                new EnergyFlowLink { From = "solar", To = "pdu:pdu1" },
                new EnergyFlowLink { From = "solar", To = "pdu:pdu2" },
            },
        };

        var graph = FlowGraphBuilder.Build(data, flow);

        Assert.Equal(200, graph.Links.Single(l => l.Source == "solar" && l.Target == "pdu:pdu1").Value);
        Assert.Equal(600, graph.Links.Single(l => l.Source == "solar" && l.Target == "pdu:pdu2").Value);
        Assert.Equal(800, graph.Links.Where(l => l.Source == "solar").Sum(l => l.Value)); // total generation preserved
    }

    [Fact]
    public void Build_ProducerFeedingConsumersWithNoDemand_SplitsEqually()
    {
        // No downstream load yet (modelling before sensors bind): fall back to an even split of generation.
        var data = OnePdu(Outlet(0, "Load", "realpower", "10"));
        var flow = new EnergyFlowConfig
        {
            Nodes =
            {
                new EnergyFlowNode { Id = "solar", Label = "Solar", Value = 900 },
                new EnergyFlowNode { Id = "a", Label = "A" },
                new EnergyFlowNode { Id = "b", Label = "B" },
                new EnergyFlowNode { Id = "c", Label = "C" },
            },
            Links =
            {
                new EnergyFlowLink { From = "solar", To = "a" },
                new EnergyFlowLink { From = "solar", To = "b" },
                new EnergyFlowLink { From = "solar", To = "c" },
            },
        };

        var graph = FlowGraphBuilder.Build(data, flow);

        Assert.All(new[] { "a", "b", "c" }, t => Assert.Equal(300, graph.Links.Single(l => l.Source == "solar" && l.Target == t).Value));
    }

    [Fact]
    public void Build_DiamondPaths_SplitDemandAmongFeeders_NoDoubleCount()
    {
        // A panel reachable from the boss both directly AND via a sub-panel (a diamond). The 100W of real
        // load must not be counted twice: the panel's two feeder links carry 50W each, and the boss totals 100W.
        var data = OnePdu(Outlet(0, "Load", "realpower", "100"));
        var flow = new EnergyFlowConfig
        {
            Nodes =
            {
                new EnergyFlowNode { Id = "boss", Label = "Boss" },
                new EnergyFlowNode { Id = "panel", Label = "Panel" },
                new EnergyFlowNode { Id = "sub", Label = "Sub" },
            },
            Links =
            {
                new EnergyFlowLink { From = "boss", To = "panel" },   // direct feeder
                new EnergyFlowLink { From = "boss", To = "sub" },
                new EnergyFlowLink { From = "sub", To = "panel" },    // second feeder into the same panel
                new EnergyFlowLink { From = "panel", To = "pdu:pdu1" },
            },
        };

        var graph = FlowGraphBuilder.Build(data, flow);

        Assert.Equal(50, graph.Links.Single(l => l.Source == "boss" && l.Target == "panel").Value);
        Assert.Equal(50, graph.Links.Single(l => l.Source == "sub" && l.Target == "panel").Value);
        Assert.Equal(100, graph.Links.Single(l => l.Source == "panel" && l.Target == "pdu:pdu1").Value);
        // The boss carries the real load once: 50 (direct) + 50 (via sub) = 100, not 200.
        Assert.Equal(100, graph.Links.Where(l => l.Source == "boss").Sum(l => l.Value));
    }

    // Walk the emitted links; true if they contain a directed cycle.
    private static bool HasCycle(FlowGraph graph)
    {
        var adj = graph.Links.GroupBy(l => l.Source, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(g => g.Key, g => g.Select(l => l.Target).ToList(), StringComparer.OrdinalIgnoreCase);
        var state = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase); // 1 = on stack, 2 = done
        bool Visit(string n)
        {
            state[n] = 1;
            if (adj.TryGetValue(n, out var kids))
                foreach (var k in kids)
                {
                    if (state.GetValueOrDefault(k) == 1) return true;
                    if (state.GetValueOrDefault(k) == 0 && Visit(k)) return true;
                }
            state[n] = 2;
            return false;
        }
        return graph.Nodes.Any(n => state.GetValueOrDefault(n.Id) == 0 && Visit(n.Id));
    }

    [Fact]
    public void Build_BreaksLoops_WhenConfigBypassesTheEditorGuard()
    {
        // A hand-edited config wires a cycle (a → b → a) and a self-loop. The builder must not hang and
        // must drop the loop-closing edges, leaving a clean DAG that still carries the real outlet load.
        var data = OnePdu(Outlet(0, "Load", "realpower", "100"));
        var flow = new EnergyFlowConfig
        {
            Nodes = { new EnergyFlowNode { Id = "a", Label = "A" }, new EnergyFlowNode { Id = "b", Label = "B" } },
            Links =
            {
                new EnergyFlowLink { From = "a", To = "b" },
                new EnergyFlowLink { From = "b", To = "a" },          // closes a 2-cycle -> dropped
                new EnergyFlowLink { From = "a", To = "a" },          // self-loop -> dropped
                new EnergyFlowLink { From = "a", To = "pdu:pdu1" },   // gives 'a' real downstream flow
            },
        };

        var graph = FlowGraphBuilder.Build(data, flow);

        Assert.False(HasCycle(graph));                                                  // no loops survive
        Assert.DoesNotContain(graph.Links, l => l.Source == l.Target);                  // no self-loop
        Assert.DoesNotContain(graph.Links, l => l.Source == "b" && l.Target == "a");    // the cycle-closing edge is gone
        Assert.Equal(100, graph.Links.Single(l => l.Source == "a" && l.Target == "pdu:pdu1").Value);
    }

    [Fact]
    public void FlowExport_NodeValue_IsMaxOfInflowAndOutflow()
    {
        // a -> b (50); b -> c (30), b -> d (20). b balances at 50; a is a 50W source; c/d are sinks.
        var graph = new FlowGraph(
            new[] { new FlowNode("a", "A", "node"), new FlowNode("b", "B", "node"), new FlowNode("c", "C", "outlet"), new FlowNode("d", "D", "outlet") },
            new[] { new FlowLink("a", "b", 50), new FlowLink("b", "c", 30), new FlowLink("b", "d", 20) },
            "realpower", "W");

        Assert.Equal(50, FlowExport.NodeValue(graph, "a"));   // source: outflow only
        Assert.Equal(50, FlowExport.NodeValue(graph, "b"));   // balanced: max(in 50, out 50)
        Assert.Equal(30, FlowExport.NodeValue(graph, "c"));   // sink: inflow only
        Assert.Equal(20, FlowExport.NodeValue(graph, "d"));
    }

    [Fact]
    public void FlowExport_Topic_FillsTemplate_SlugsIds_AndCollapsesEmptySegments()
    {
        var graph = new FlowGraph(new[] { new FlowNode("outlet:rack_pdu:10", "Dell MD1200", "outlet") }, Array.Empty<FlowLink>(), "realpower", "W");
        var node = graph.Nodes[0];

        var cfg = new EnergyFlowConfig();   // default template "{parent}/energyflow/{id}"
        Assert.Equal("rpdu2mqtt/energyflow/outlet_rack_pdu_10", FlowExport.Topic(node, graph, "rpdu2mqtt", cfg));

        cfg.MqttTopicTemplate = "{parent}/{kind}/{label}/{metric}";
        Assert.Equal("rpdu2mqtt/outlet/Dell_MD1200/realpower", FlowExport.Topic(node, graph, "rpdu2mqtt/", cfg));

        // An empty parent must not leave a leading slash.
        cfg.MqttTopicTemplate = "{parent}/energyflow/{id}";
        Assert.Equal("energyflow/outlet_rack_pdu_10", FlowExport.Topic(node, graph, "", cfg));
    }
}
