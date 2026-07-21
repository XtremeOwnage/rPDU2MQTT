using rPDU2MQTT.Abstractions.Pdu;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Grains.Abstractions.Pdu;
using rPDU2MQTT.Grains.Pdu;
using rPDU2MQTT.Models.Config;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// Which PDU a child grain writes through. The solution bridges any number of PDUs, so an outlet or group on
/// the second PDU must not be actioned through the first — the owning instance is stamped by the parent
/// PduGrain and honoured here.
/// </summary>
public class PduOwnershipTests
{
    private static PduConfig Pdu(string host) { var c = new PduConfig(); c.Connection.Host = host; return c; }

    private static PduInstanceRegistry Registry(params (string id, string host)[] pdus)
    {
        var cfg = new Config();
        foreach (var (id, host) in pdus) cfg.Pdus[id] = Pdu(host);
        return new PduInstanceRegistry(cfg, new PduInstanceFactory(cfg));
    }

    [Fact]
    public void Child_WritesThrough_TheInstanceItBelongsTo()
    {
        var registry = Registry(("default", "10.0.0.1"), ("rack-b", "10.0.0.2"), ("rack-c", "10.0.0.3"));

        Assert.Equal("rack-b", PduOwner.Choose("rack-b", registry.All.Keys, registry.PrimaryId));
        Assert.Equal("rack-c", PduOwner.Choose("rack-c", registry.All.Keys, registry.PrimaryId));
        Assert.Equal("default", PduOwner.Choose("default", registry.All.Keys, registry.PrimaryId));

        // The bound id is the PDU's own, whatever case the topic/config used.
        Assert.Equal("rack-b", PduOwner.Choose("RACK-B", registry.All.Keys, registry.PrimaryId));

        // And it resolves to a *different* PDU object than the primary — the whole point.
        Assert.NotSame(registry.Primary, registry.Get(PduOwner.Choose("rack-b", registry.All.Keys, registry.PrimaryId)!));
    }

    [Fact]
    public void Unbound_Or_RemovedInstance_FallsBackToThePrimary()
    {
        var registry = Registry(("default", "10.0.0.1"), ("rack-b", "10.0.0.2"));

        // A child that hasn't been polled yet has nothing stamped on it.
        Assert.Equal("default", PduOwner.Choose(null, registry.All.Keys, registry.PrimaryId));

        // An instance that has since been removed from config must not strand the child.
        Assert.Equal("default", PduOwner.Choose("rack-gone", registry.All.Keys, registry.PrimaryId));
    }

    [Fact]
    public void SingleInstance_IsUnambiguous_EvenWithNoPrimary()
    {
        Assert.Equal("only", PduOwner.Choose(null, new[] { "only" }, null));
        Assert.Null(PduOwner.Choose(null, new[] { "a", "b" }, null));
        Assert.Null(PduOwner.Choose(null, System.Array.Empty<string>(), "default"));
    }
}

/// <summary>The PDU's child grains carry their owning instance, so a write can be routed back to it.</summary>
public class PduChildOwnershipGrainTests
{
    [Fact]
    public async Task Outlet_And_Group_Carry_TheirInstance()
    {
        var cluster = await GrainTestCluster.StartAsync();
        try
        {
            var outlet = cluster.GrainFactory.GetGrain<IOutletGrain>(IOutletGrain.KeyFor("pdu-b", 1));
            await outlet.Observe(OutletGrainTests.Outlet(1), "pdu-b", "rack-b", System.DateTime.UtcNow);
            Assert.Equal("rack-b", (await outlet.State())!.InstanceId);

            // Binding a group is idempotent and doesn't need a PDU present; control still degrades cleanly
            // in a bare cluster (no instance registry, no PDU).
            var group = cluster.GrainFactory.GetGrain<IOneViewGroupGrain>("rack-1");
            await group.Bind("rack-b");
            await group.Bind("rack-b");
            Assert.Contains("No PDU", await group.Control("on"));
        }
        finally { await cluster.StopAllSilosAsync(); }
    }
}
