using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Services;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// Modbus TCP energy-flow sources (#129): register decoding, binding flatten, and the composite that merges
/// several ingests. The socket I/O isn't exercised here (no device), but every decision the decode makes is.
/// </summary>
public class ModbusSourceTests
{
    [Fact]
    public void Decode_Uint16_AndInt16()
    {
        Assert.Equal(40000, ModbusDecode.Decode(new ushort[] { 40000 }, "uint16", "big"));
        Assert.Equal(-1, ModbusDecode.Decode(new ushort[] { 0xFFFF }, "int16", "big"));
    }

    [Fact]
    public void Decode_Uint32_HonoursWordOrder()
    {
        // 0x0001_0000 = 65536. Big = high word first; little = word-swapped.
        Assert.Equal(65536, ModbusDecode.Decode(new ushort[] { 0x0001, 0x0000 }, "uint32", "big"));
        Assert.Equal(65536, ModbusDecode.Decode(new ushort[] { 0x0000, 0x0001 }, "uint32", "little"));
    }

    [Fact]
    public void Decode_Int32_IsSigned()
        => Assert.Equal(-2, ModbusDecode.Decode(new ushort[] { 0xFFFF, 0xFFFE }, "int32", "big"));

    [Fact]
    public void Decode_Float32_ReadsIeee754()
    {
        // 1.0f = 0x3F800000; 230.5f = 0x43668000.
        Assert.Equal(1.0, ModbusDecode.Decode(new ushort[] { 0x3F80, 0x0000 }, "float32", "big"));
        Assert.Equal(230.5, ModbusDecode.Decode(new ushort[] { 0x4366, 0x8000 }, "float32", "big"), 3);
    }

    [Fact]
    public void RegisterCount_Is1For16Bit_2For32Bit()
    {
        Assert.Equal(1, ModbusDecode.RegisterCount("uint16"));
        Assert.Equal(1, ModbusDecode.RegisterCount("int16"));
        Assert.Equal(2, ModbusDecode.RegisterCount("uint32"));
        Assert.Equal(2, ModbusDecode.RegisterCount("float32"));
        Assert.Equal(1, ModbusDecode.RegisterCount(null));   // defaults to uint16
    }

    [Fact]
    public void BuildBindings_GroupsModbusSourcesByConnection_AndIgnoresMqtt()
    {
        var nodes = new[]
        {
            Node("solar", new EnergyFlowSource { Type = "modbus", Connection = "inv1", Register = 100, Metric = "realpower" }),
            Node("meter", new EnergyFlowSource { Type = "modbus", Connection = "inv1", Register = 200, Metric = "energy" }),
            Node("grid",  new EnergyFlowSource { Type = "mqtt", Topic = "x", Metric = "realpower" }),   // not modbus
            Node("bad",   new EnergyFlowSource { Type = "modbus", Register = 1, Metric = "realpower" }), // no connection
        };

        var byConn = EnergyFlowModbusSourceService.BuildBindings(nodes);

        Assert.Single(byConn);
        Assert.Equal(2, byConn["inv1"].Count);
    }

    [Fact]
    public void Composite_ReturnsTheFirstSourceWithAValue()
    {
        var mqtt = new FlowValueCache();
        var modbus = new FlowValueCache();
        modbus.Set("solar", "realpower", 6000, 900, DateTime.UtcNow);
        var composite = new CompositeFlowValueSource(mqtt, modbus);

        Assert.True(composite.TryGetValue("solar", "realpower", out var v));
        Assert.Equal(6000, v);
        Assert.False(composite.TryGetValue("solar", "energy", out _));
    }

    private static EnergyFlowNode Node(string id, params EnergyFlowSource[] sources)
    {
        var n = new EnergyFlowNode { Id = id, Label = id };
        n.Sources.AddRange(sources);
        return n;
    }
}
