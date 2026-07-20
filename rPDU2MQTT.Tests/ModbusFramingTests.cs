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

/// <summary>
/// The read-failure classifier turns raw exceptions into causes the user can act on — the three modes
/// (rejected request, no response, socket error) point at different fixes.
/// </summary>
public class ModbusExplainTests
{
    [Fact]
    public void Timeout_PointsAtUnitIdAndSerialSettings()
    {
        var msg = EnergyFlowModbusSourceService.Explain(new TimeoutException());
        Assert.Contains("did not respond", msg);
        Assert.Contains("unit", msg, System.StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ConnectionTimedOutMessage_IsTreatedAsNoResponse()
    {
        var msg = EnergyFlowModbusSourceService.Explain(new System.IO.IOException("Connection timed out"));
        Assert.Contains("did not respond", msg);
    }

    [Fact]
    public void SocketError_IsReportedAsSuch()
    {
        var msg = EnergyFlowModbusSourceService.Explain(new System.Net.Sockets.SocketException(10061));
        Assert.Contains("socket error", msg, System.StringComparison.OrdinalIgnoreCase);
    }
}
