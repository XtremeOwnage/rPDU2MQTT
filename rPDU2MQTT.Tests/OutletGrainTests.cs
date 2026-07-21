using rPDU2MQTT.Abstractions.Flow;
using rPDU2MQTT.Core.Transport;
using rPDU2MQTT.Grains.Abstractions.Flow;
using rPDU2MQTT.Grains.Abstractions.Pdu;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// Each outlet is its own grain (key deviceId|index): its device grain hands it its document, it extracts
/// its own state from it, and it is the single owner of writes. Confirms the read side + key round-trip;
/// the write path degrades gracefully when no PDU is wired (as in this bare test cluster).
/// </summary>
public class OutletGrainTests
{
    internal static RawOutlet Outlet(int key, string? state = "on", params (string type, string value, string? units)[] measurements)
        => new(key, "Server", "Server", "Server", "Server PSU", null, null, state,
            measurements.Select(m => new RawMeasurement(m.type, m.type, m.type, m.type, m.value, m.units, "normal")).ToList());

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

            await outlet.Observe(Outlet(3), "pdu-a", "default", System.DateTime.UtcNow);
            var s = await outlet.State();
            Assert.NotNull(s);
            Assert.Equal(3, s!.Index);
            Assert.Equal("on", s.PowerState);
            Assert.Equal("default", s.InstanceId);

            // It keeps the document it extracted that from, so nothing is lost by the parent not pre-picking.
            Assert.Equal(3, (await outlet.Document())!.Key);

            // (The write path — which PDU a control action reaches — is PduOwnershipTests.)
        }
        finally { await cluster.StopAllSilosAsync(); }
    }
}

/// <summary>The PDU supervisor's other children: the device grain and the OneView group control grain.</summary>
public class PduChildGrainTests
{
    [Fact]
    public async Task DeviceGrain_TakesTheDocument_AndSupervisesItsOutlets()
    {
        var cluster = await GrainTestCluster.StartAsync();
        try
        {
            var f = cluster.GrainFactory;
            var dev = f.GetGrain<IPduDeviceGrain>("pdu-a");
            Assert.Null(await dev.State());

            // The parent hands over the whole device document — nothing pre-extracted.
            var document = new RawDevice("pdu-a", "PDU A", "PDU A", "pdu-a", "Rack PDU A", "Vertiv", "rPDU2", "normal", "pdu",
                new()
                {
                    OutletGrainTests.Outlet(1, "on", ("realpower", "120", "W")),
                    OutletGrainTests.Outlet(2, "off", ("realpower", "0.08", "kW")),
                },
                new());
            await dev.Observe(document, "default", System.DateTime.UtcNow);

            var s = await dev.State();
            Assert.Equal("Vertiv", s!.Make);
            Assert.Equal("normal", s.State);
            Assert.Equal("default", s.InstanceId);

            // Its outlets got their own documents, and extracted their own state from them.
            var outlet2 = await f.GetGrain<IOutletGrain>(IOutletGrain.KeyFor("pdu-a", 2)).State();
            Assert.Equal("off", outlet2!.PowerState);

            // ...and their own measurements, converted to canonical units, into their flow node — which the
            // device's aggregate node then sums (120 W + 0.08 kW).
            Assert.Equal(80, await f.GetGrain<IMeasuredNodeGrain>("outlet:pdu-a:2").Value(Metric.RealPower));
            Assert.Equal(200, await f.GetGrain<IAggregateNodeGrain>("pdu:pdu-a").Value(Metric.RealPower));
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
