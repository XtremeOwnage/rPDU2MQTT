using rPDU2MQTT.Grains.Abstractions.Pdu;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// Which PDU a write reaches. The solution bridges any number of PDUs, so an outlet or group on the second
/// PDU must never be actioned through the first. A child grain doesn't resolve a PDU for itself: it holds
/// the instance its parent stamped on it and asks that parent — whose grain key <i>is</i> the instance id —
/// to make the device call.
/// </summary>
public class PduOwnershipTests
{
    [Fact]
    public async Task PduGrain_OnlyEverTalksTo_ItsOwnInstance()
    {
        var cluster = await GrainTestCluster.StartAsync();
        try
        {
            // A grain keyed to an instance that isn't configured has no device to talk to, and says so —
            // rather than falling back to some other PDU that happens to be registered.
            var absent = cluster.GrainFactory.GetGrain<IPduGrain>("rack-b");
            Assert.Contains("'rack-b' is not configured", await absent.ControlOutlet("pdu-b", 1, "on"));
            Assert.Contains("'rack-b' is not configured", await absent.ControlGroup("rack-1", "on"));
            Assert.Equal("", await absent.SetOutletConfig("pdu-b", 1, "onDelay", "5", isDelay: true));
        }
        finally { await cluster.StopAllSilosAsync(); }
    }

    [Fact]
    public async Task UnclaimedChild_WritesToNothing()
    {
        var cluster = await GrainTestCluster.StartAsync();
        try
        {
            var f = cluster.GrainFactory;

            // Nothing has polled these, so nothing knows which PDU they're on. The honest answer is to write
            // to none of them — not to guess at the primary.
            var outlet = f.GetGrain<IOutletGrain>(IOutletGrain.KeyFor("pdu-unknown", 1));
            Assert.Contains("No PDU", await outlet.Control("off"));
            Assert.Equal("", await outlet.SetConfig("onDelay", "5", isDelay: true));

            var group = f.GetGrain<IOneViewGroupGrain>("group-unknown");
            Assert.Contains("No PDU", await group.Control("on"));
            Assert.Contains("Unknown group action", await group.Control("frobnicate"));
        }
        finally { await cluster.StopAllSilosAsync(); }
    }

    [Fact]
    public async Task Child_KeepsTheInstance_ItsParentStamped()
    {
        var cluster = await GrainTestCluster.StartAsync();
        try
        {
            var f = cluster.GrainFactory;

            var outlet = f.GetGrain<IOutletGrain>(IOutletGrain.KeyFor("pdu-b", 1));
            await outlet.Observe(OutletGrainTests.Outlet(1), "pdu-b", "rack-b", System.DateTime.UtcNow);
            Assert.Equal("rack-b", (await outlet.State())!.InstanceId);

            // Its writes now address rack-b's grain, which isn't configured in this cluster — so the failure
            // names rack-b. That's the proof it didn't quietly write through the one PDU that does exist.
            Assert.Contains("'rack-b' is not configured", await outlet.Control("off"));

            // Binding a group is idempotent, and routes the same way.
            var group = f.GetGrain<IOneViewGroupGrain>("rack-1");
            await group.Bind("rack-b");
            await group.Bind("rack-b");
            Assert.Contains("'rack-b' is not configured", await group.Control("on"));
        }
        finally { await cluster.StopAllSilosAsync(); }
    }
}
