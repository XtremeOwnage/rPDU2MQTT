using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Modbus;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Services;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// Which Modbus devices get polled, and how many readers each one gets.
/// <para>
/// The rule: two config connections pointing at the same <c>host:port:unitId</c> are ONE device and ONE
/// reader. Many RS485-to-Ethernet gateways accept a single TCP client at a time, so a second poller does
/// not read twice as fast — it makes both reads time out.
/// </para>
/// </summary>
public class ModbusPollServiceTests
{
    private static ModbusConnection Connection(string id, string host, int port = 502, int unitId = 1)
        => new() { Id = id, Enabled = true, Host = host, Port = port, UnitId = unitId };

    private static EnergyFlowNode Node(string id, string connection, int register)
        => new()
        {
            Id = id,
            Sources = [new EnergyFlowSource { Type = "modbus", Metric = "realpower", Connection = connection, Register = register }],
        };

    private static ModbusPollService Service(Config cfg) => new(cfg, new ModbusDevices());

    [Fact]
    public void TwoConnectionsToOneGateway_AreOneDevice_WithBothTheirBindings()
    {
        var cfg = new Config();
        cfg.Modbus.Connections = [Connection("inverter", "10.0.0.5"), Connection("meter", "10.0.0.5")];
        cfg.EnergyFlow.Nodes = [Node("inverter", "inverter", 100), Node("meter", "meter", 200)];

        var device = Assert.Single(Service(cfg).Devices());
        Assert.Equal("10.0.0.5|502|1", device.Key);
        Assert.Equal([100, 200], device.Device.Bindings.Select(b => b.Register).OrderBy(r => r));
    }

    [Fact]
    public void DifferentUnitIdsOnOneHost_AreDifferentDevices()
    {
        // Same gateway, different slaves behind it: still one TCP client, but the addresses are distinct and
        // each needs its own read.
        var cfg = new Config();
        cfg.Modbus.Connections = [Connection("a", "10.0.0.5", unitId: 1), Connection("b", "10.0.0.5", unitId: 2)];
        cfg.EnergyFlow.Nodes = [Node("a", "a", 1), Node("b", "b", 2)];

        Assert.Equal(["10.0.0.5|502|1", "10.0.0.5|502|2"], Service(cfg).Devices().Select(d => d.Key).OrderBy(k => k));
    }

    [Fact]
    public void ADeviceNothingIsBoundTo_IsNotPolledAtAll()
    {
        // A connection nobody reads from is configuration, not work. Opening its socket every interval would
        // hold a single-client gateway open for nothing.
        var cfg = new Config();
        cfg.Modbus.Connections = [Connection("unused", "10.0.0.9")];
        cfg.EnergyFlow.Nodes = [];

        Assert.Empty(Service(cfg).Devices());
    }

    [Fact]
    public void ADisabledConnection_IsNotPolled()
    {
        var cfg = new Config();
        var off = Connection("inverter", "10.0.0.5");
        off.Enabled = false;
        cfg.Modbus.Connections = [off];
        cfg.EnergyFlow.Nodes = [Node("inverter", "inverter", 100)];

        Assert.Empty(Service(cfg).Devices());
    }
}
