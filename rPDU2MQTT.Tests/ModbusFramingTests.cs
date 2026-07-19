using rPDU2MQTT.Services;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>Framing selection for Modbus connections: 'auto' tries both, an explicit value pins one.</summary>
public class ModbusFramingTests
{
    [Theory]
    [InlineData("auto")]
    [InlineData("")]
    [InlineData(null)]
    [InlineData("something-else")]
    public void Auto_TriesNativeTcpThenRtuOverTcp(string? framing)
        => Assert.Equal(new[] { "tcp", "rtu-over-tcp" }, EnergyFlowModbusSourceService.FramingCandidates(framing));

    [Theory]
    [InlineData("tcp")]
    [InlineData("TCP")]
    public void Tcp_PinsNativeTcp(string framing)
        => Assert.Equal(new[] { "tcp" }, EnergyFlowModbusSourceService.FramingCandidates(framing));

    [Theory]
    [InlineData("rtu-over-tcp")]
    [InlineData("RTU-OVER-TCP")]
    [InlineData("rtu")]
    public void RtuOverTcp_PinsRtu(string framing)
        => Assert.Equal(new[] { "rtu-over-tcp" }, EnergyFlowModbusSourceService.FramingCandidates(framing));
}
