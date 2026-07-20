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
