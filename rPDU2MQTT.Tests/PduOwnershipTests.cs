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

        Assert.Same(registry.Get("rack-b"), PduChildGrain.PduFor(registry, "rack-b"));
        Assert.Same(registry.Get("rack-c"), PduChildGrain.PduFor(registry, "rack-c"));

        // Not the primary — the whole point.
        Assert.NotSame(registry.Primary, PduChildGrain.PduFor(registry, "rack-b"));

        // Instance ids are matched the way config keys them, so casing can't strand a child.
        Assert.Same(registry.Get("rack-b"), PduChildGrain.PduFor(registry, "RACK-B"));
    }

    [Fact]
    public void Unbound_Or_RemovedInstance_FallsBackToThePrimary()
    {
        var registry = Registry(("default", "10.0.0.1"), ("rack-b", "10.0.0.2"));

        // A child whose parent hasn't polled it yet has no owner stamped on it.
        Assert.Same(registry.Primary, PduChildGrain.PduFor(registry, null));

        // An instance that has since been removed from config must not strand the child either.
        Assert.Same(registry.Primary, PduChildGrain.PduFor(registry, "rack-gone"));
    }

    [Fact]
    public void SingleInstance_IsUnambiguous()
    {
        var registry = Registry(("only", "10.0.0.9"));
        Assert.Same(registry.Get("only"), PduChildGrain.PduFor(registry, null));
        Assert.Same(registry.Get("only"), PduChildGrain.PduFor(registry, "only"));
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
