using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Models.PDU;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// "Unmeasured" and "unavailable" are not the same thing. Reconstructed from the live system that showed
/// 5.81 A of solar generation after dark, which was the whole house load back-filled from the PDU totals and
/// attributed to a PV array in the night because its feed had stopped reporting.
/// </summary>
public class UnavailableFeederTests
{
    private sealed class Fixed : IFlowValueSource
    {
        private readonly Dictionary<string, double> v;
        public Fixed(Dictionary<string, double> x) => v = x;
        public bool TryGetValue(string node, string metric, out double value) => v.TryGetValue(node + "|" + metric, out value);
    }

    /// <summary>solar + grid feed the inverter, which feeds the panel, which feeds a metered load.</summary>
    private static EnergyFlowConfig Topology(bool solarHasSource = true, bool gridInert = true)
    {
        var c = new EnergyFlowConfig();
        var solar = new EnergyFlowNode { Id = "solar", Kind = "solar" };
        if (solarHasSource)
            solar.Sources.Add(new EnergyFlowSource { Type = "mqtt", Metric = "realpower", Topic = "sa/pv_power" });
        c.Nodes.Add(solar);
        c.Nodes.Add(new EnergyFlowNode { Id = "grid", Kind = "grid", Mode = gridInert ? "none" : "auto" });
        c.Nodes.Add(new EnergyFlowNode { Id = "inverter", Kind = "inverter" });
        c.Nodes.Add(new EnergyFlowNode { Id = "panel", Kind = "panel" });
        c.Links.Add(new EnergyFlowLink { From = "solar", To = "inverter" });
        c.Links.Add(new EnergyFlowLink { From = "grid", To = "inverter" });
        c.Links.Add(new EnergyFlowLink { From = "inverter", To = "panel" });
        c.Links.Add(new EnergyFlowLink { From = "panel", To = "pdu:pdu1" });
        return c;
    }

    private static PduData Pdu(double watts)
    {
        var o = new Outlet { Key = 0, Entity_Name = "o0", Entity_DisplayName = "Load" };
        o.Measurements.Add(new Measurement { Type = "realpower", Value = watts.ToString(), Units = "W" });
        o.Measurements.Add(new Measurement { Type = "apparentpower", Value = watts.ToString(), Units = "VA" });
        var d = new Device { Key = "pdu1", Entity_Name = "pdu1", Entity_DisplayName = "PDU 1" };
        d.Outlets.Add(o);
        var data = new PduData();
        data.Devices.Add(d);
        return data;
    }

    [Fact]
    public void ASolarNodeWhoseFeedIsDead_DoesNotGetCreditedWithTheWholeHouseLoad()
    {
        // Solar has a realpower source bound and it is reporting nothing. Grid is Mode:none, so solar was
        // the only remaining candidate and conservation handed it the entire load — 5.81 A of generation
        // after dark, on the diagram whose whole purpose is to be accurate.
        var graph = FlowGraphBuilder.Build(Pdu(700), Topology(), "realpower", new Fixed(new()));

        var solar = graph.Nodes.Single(n => n.Id == "solar");
        Assert.Null(solar.Value);   // unknown, not "whatever balances the equation"

        var link = graph.Links.Single(l => l.Source == "solar" && l.Target == "inverter");
        Assert.False(link.Known);   // drawn as no-data, so the failed feed is visible
        Assert.Equal(0, link.Value);
    }

    [Fact]
    public void AZeroReading_IsStillHonoured_BecauseSolarAtNightGenuinelyGeneratesNothing()
    {
        // The distinction that matters: a source reporting 0 is a measurement. It must keep making solar a
        // measured producer supplying nothing, not revert it to an inferable unknown.
        var graph = FlowGraphBuilder.Build(Pdu(700), Topology(), "realpower",
            new Fixed(new() { ["solar|realpower"] = 0 }));

        Assert.Equal(0, graph.Nodes.Single(n => n.Id == "solar").Value);
    }

    [Fact]
    public void AReportingSolarNode_SuppliesItsRealFigure_Unchanged()
    {
        var graph = FlowGraphBuilder.Build(Pdu(700), Topology(), "realpower",
            new Fixed(new() { ["solar|realpower"] = 900 }));

        Assert.Equal(900, graph.Nodes.Single(n => n.Id == "solar").Value);
        Assert.True(graph.Links.Single(l => l.Source == "solar" && l.Target == "inverter").Known);
    }

    [Fact]
    public void ANodeWithNoSourceBoundAtAll_CanStillBeInferred()
    {
        // The rule must not kill legitimate inference. A node nothing was ever going to measure, with exactly
        // one path for the load to arrive by, really is determined by conservation — that is the whole point
        // of the single-unmeasured-feeder rule and it stays.
        var graph = FlowGraphBuilder.Build(Pdu(700), Topology(solarHasSource: false), "realpower", new Fixed(new()));

        Assert.Equal(700, graph.Nodes.Single(n => n.Id == "solar").Value);
    }

    [Fact]
    public void ABindingForADifferentMetric_IsNotAFailureToReportThisOne()
    {
        // Solar is bound for realpower only. Viewed in apparentpower it was never asked to report, so it is
        // unmeasured rather than unavailable and inference applies as before.
        var graph = FlowGraphBuilder.Build(
            Pdu(700), Topology(), "apparentpower", new Fixed(new()));

        Assert.NotNull(graph.Nodes.Single(n => n.Id == "solar").Value);
    }
}
