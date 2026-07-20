using rPDU2MQTT.Abstractions.Pdu;
using rPDU2MQTT.Grains.Abstractions.Pdu;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// Each outlet is its own grain (key deviceId|index): it holds the observed state pushed by its PDU grain
/// and is the single owner of writes. Confirms the read side + key round-trip; the write path degrades
/// gracefully when no PDU is wired (as in this bare test cluster).
/// </summary>
public class OutletGrainTests
{
    [Fact]
    public async Task Outlet_ObservesState_AndIsAddressable()
    {
        var cluster = await GrainTestCluster.StartAsync();
        try
        {
            var key = IOutletGrain.KeyFor("pdu-a", 3);
            Assert.Equal("pdu-a|3", key);

            var outlet = cluster.GrainFactory.GetGrain<IOutletGrain>(key);
            Assert.Null(await outlet.State());

            await outlet.Observe(new OutletState("pdu-a", 3, "Server", "Server PSU", "on", System.DateTime.UtcNow));
            var s = await outlet.State();
            Assert.NotNull(s);
            Assert.Equal(3, s!.Index);
            Assert.Equal("on", s.PowerState);

            // No PDU registered in the bare cluster → control reports unavailable instead of throwing.
            Assert.Contains("No PDU", await outlet.Control("off"));
        }
        finally { await cluster.StopAllSilosAsync(); }
    }
}

/// <summary>The PDU supervisor's other children: the device (base data) grain and the OneView group control grain.</summary>
public class PduChildGrainTests
{
    [Fact]
    public async Task DeviceGrain_ObservesBaseData()
    {
        var cluster = await GrainTestCluster.StartAsync();
        try
        {
            var dev = cluster.GrainFactory.GetGrain<IPduDeviceGrain>("pdu-a");
            Assert.Null(await dev.State());
            await dev.Observe(new DeviceState("pdu-a", "PDU A", "Rack PDU A", "Vertiv", "rPDU2", "normal", System.DateTime.UtcNow));
            var s = await dev.State();
            Assert.Equal("Vertiv", s!.Make);
            Assert.Equal("normal", s.State);
        }
        finally { await cluster.StopAllSilosAsync(); }
    }

    [Fact]
    public async Task GroupGrain_DegradesGracefully_WithoutPdu()
    {
        var cluster = await GrainTestCluster.StartAsync();
        try
        {
            var group = cluster.GrainFactory.GetGrain<IOneViewGroupGrain>("rack-1");
            Assert.Contains("No PDU", await group.Control("on"));
            Assert.Contains("Unknown group action", await group.Control("frobnicate"));
        }
        finally { await cluster.StopAllSilosAsync(); }
    }
}
