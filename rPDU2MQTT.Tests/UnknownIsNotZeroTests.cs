using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Models.PDU;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// The difference between "nothing is flowing" and "nobody knows". Both come out of the builder as a
/// number-shaped hole, and the whole hierarchy is built on which one it is.
/// </summary>
public class UnknownIsNotZeroTests
{
    private sealed class Fixed : IFlowValueSource
    {
        private readonly Dictionary<string, double> v;
        public Fixed(Dictionary<string, double> x) => v = x;
        public bool TryGetValue(string node, string metric, out double value) => v.TryGetValue(node + "|" + metric, out value);
    }

    /// <summary>inverter feeds two loads; neither has a reading of its own.</summary>
    private static EnergyFlowConfig Topology()
    {
        var c = new EnergyFlowConfig();
        c.Nodes.Add(new EnergyFlowNode { Id = "inverter", Kind = "inverter" });
        c.Nodes.Add(new EnergyFlowNode { Id = "garage", Kind = "load" });
        c.Nodes.Add(new EnergyFlowNode { Id = "attic", Kind = "load" });
        c.Links.Add(new EnergyFlowLink { From = "inverter", To = "garage" });
        c.Links.Add(new EnergyFlowLink { From = "inverter", To = "attic" });
        return c;
    }

    [Fact]
    public void ANodeWhoseSourceSaidItDoesNotKnow_IsUnknown_NotZero()
    {
        // The case that produced this: a node bound to a Home Assistant entity reading "unavailable". The
        // value source correctly records nothing — and the node still came out as a confident 0, exported
        // to Prometheus as 0 and drawn as a real zero, because a link into it existed.
        var graph = FlowGraphBuilder.Build(new PduData(), Topology(), "realpower",
            new Fixed(new Dictionary<string, double>()));

        var attic = graph.Nodes.Single(n => n.Id == "attic");
        Assert.Null(attic.Value);
        Assert.Equal(FlowDerivation.Unknown, attic.Derivation);
    }

    [Fact]
    public void ANodeWhoseFeederIsMeasuredAtZero_IsZero_NotUnknown()
    {
        // The other half: when the thing feeding it IS measured and reads zero, zero is the answer — an
        // inverter that is off is not a mystery.
        var graph = FlowGraphBuilder.Build(new PduData(), Topology(), "realpower",
            new Fixed(new Dictionary<string, double> { ["inverter|realpower"] = 0 }));

        Assert.Equal(0, graph.Nodes.Single(n => n.Id == "inverter").Value);
    }

    [Fact]
    public void AMeasuredZeroOutlet_IsReported_SoOffIsNotSilence()
    {
        var device = new Device { Key = "pdu1", Entity_Name = "pdu1", Entity_DisplayName = "Rack PDU" };
        foreach (var (key, watts) in new[] { (0, "120"), (1, "0") })
        {
            var outlet = new Outlet { Key = key, Entity_Name = $"outlet{key}", Entity_DisplayName = $"Outlet {key + 1}" };
            outlet.Measurements.Add(new Measurement { Type = "realpower", Value = watts, Units = "W" });
            device.Outlets.Add(outlet);
        }
        var data = new PduData();
        data.Devices.Add(device);

        var graph = FlowGraphBuilder.Build(data, new EnergyFlowConfig(), "realpower");

        // Both outlets are reported; the off one at zero, so a consumer can tell it from one that stopped
        // reporting altogether.
        Assert.Equal(120, graph.Nodes.Single(n => n.Id == "outlet:pdu1:0").Value);
        Assert.Equal(0, graph.Nodes.Single(n => n.Id == "outlet:pdu1:1").Value);
        Assert.Equal(FlowDerivation.Measured, graph.Nodes.Single(n => n.Id == "outlet:pdu1:1").Derivation);
    }
}

/// <summary>
/// A negative reading on a metric that only flows forwards. The graph has to clamp it — a ribbon cannot run
/// backwards — but a clamp nobody is told about turns a meter running in reverse into a load drawing
/// nothing, which is the one reading an operator would most want to see.
/// </summary>
public class ClampedNegativeIsReportedTests
{
    [Fact]
    public void ANegativeReading_IsShownAsZero_AndSaidOutLoud()
    {
        var cache = new FlowValueCache();
        cache.Set("well", "realpower", -500, 900, DateTime.UtcNow);

        var withheld = Assert.Single(cache.Withheld);
        Assert.Equal("well", withheld.Node);
        Assert.Contains("-500", withheld.Reason);
        Assert.Contains("realpower#in", withheld.Reason);

        // The graph still clamps it: a negative cannot be drawn as flow.
        var flow = new EnergyFlowConfig();
        flow.Nodes.Add(new EnergyFlowNode { Id = "well", Kind = "load" });
        var graph = FlowGraphBuilder.Build(new rPDU2MQTT.Models.PDU.PduData(), flow, "realpower", cache);
        Assert.Equal(0, graph.Nodes.Single(n => n.Id == "well").Value);
    }

    [Fact]
    public void APositiveReadingClearsIt()
    {
        var cache = new FlowValueCache();
        cache.Set("well", "realpower", -500, 900, DateTime.UtcNow);
        cache.Set("well", "realpower", 40, 900, DateTime.UtcNow);

        Assert.Empty(cache.Withheld);
    }

    [Fact]
    public void AReverseDirectionReadingIsNotACompliant()
    {
        // realpower#in is the direction that is SUPPOSED to carry the other way; a value on it is not a
        // misconfiguration to report.
        var cache = new FlowValueCache();
        cache.Set("battery", "realpower#in", -10, 900, DateTime.UtcNow);

        Assert.Empty(cache.Withheld);
    }
}
