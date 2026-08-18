using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Models.PDU;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// What a view of a past instant may show. A stored value is the only thing that can be true about a moment
/// that has gone; the device snapshot is what it reads NOW, and using it to fill a gap makes a view that is
/// half then and half now with nothing marking which is which.
/// </summary>
public class HistoricalViewTests
{
    private static PduData Snapshot(params (int Key, double Watts)[] outlets)
    {
        var device = new Device { Key = "pdu0", Entity_Name = "pdu0", Entity_DisplayName = "Rack PDU" };
        foreach (var (key, watts) in outlets)
        {
            var outlet = new Outlet { Key = key, Entity_Name = $"outlet{key}", Entity_DisplayName = $"Outlet {key + 1}", State = "on" };
            outlet.Measurements.Add(new Measurement { Type = "realpower", Value = watts.ToString(), Units = "W" });
            device.Outlets.Add(outlet);
        }
        var data = new PduData();
        data.Devices.Add(device);
        return data;
    }

    [Fact]
    public void APastInstantShowsOnlyWhatWasStoredForIt()
    {
        // Two outlets are live at 100 W and 200 W; history holds a value for the first one only.
        var data = Snapshot((0, 100), (1, 200));
        var stored = new HistoricalFlowValueSource(
            new Dictionary<string, double> { ["outlet:pdu0:0"] = 42 }, "realpower");

        var graph = FlowGraphBuilder.Build(data, new EnergyFlowConfig(), "realpower", stored);

        var ids = graph.Nodes.Select(n => n.Id).ToList();
        Assert.Equal(42, graph.Nodes.Single(n => n.Id == "outlet:pdu0:0").Value);
        // The outlet history knows nothing about is absent, NOT shown at its current 200 W.
        Assert.DoesNotContain("outlet:pdu0:1", ids);
    }

    [Fact]
    public void TheLiveViewStillPrefersTheDevicesOwnReading()
    {
        // The same graph without an exclusive source: the snapshot is exactly what should be shown.
        var data = Snapshot((0, 100), (1, 200));
        var graph = FlowGraphBuilder.Build(data, new EnergyFlowConfig(), "realpower");

        Assert.Equal(100, graph.Nodes.Single(n => n.Id == "outlet:pdu0:0").Value);
        Assert.Equal(200, graph.Nodes.Single(n => n.Id == "outlet:pdu0:1").Value);
    }

    [Fact]
    public void AnOrdinaryLiveSourceIsNotExclusive()
    {
        // The flag is opt-in: everything that supplies live values keeps filling gaps as before.
        Assert.False(((IFlowValueSource)new FlowValueCache()).Exclusive);
        Assert.True(new HistoricalFlowValueSource(new Dictionary<string, double>(), "realpower").Exclusive);
    }
}
