using System.ComponentModel;
using System.ComponentModel.DataAnnotations;

namespace rPDU2MQTT.Models.Config;

/// <summary>
/// Modbus TCP connections (#129) an energy-flow node can be fed from — an inverter, a meter, a PLC that
/// already speaks Modbus. Set the connections up here once, then bind a node's value to one by picking the
/// connection and a register in the Flow editor. Polled by <c>EnergyFlowModbusSourceService</c> into the
/// same live-value seam as the MQTT sources.
/// </summary>
public class ModbusConfig
{
    [Description("Modbus TCP devices to poll. Add one per device, then reference it from a source binding's Connection.")]
    public List<ModbusConnection> Connections { get; set; } = new();
}

/// <summary>One Modbus TCP device.</summary>
public class ModbusConnection
{
    [Description("Stable id used to reference this connection from a source binding.")]
    public string Id { get; set; } = "";

    [Description("Friendly name for the device (shown in the editor).")]
    public string Name { get; set; } = "";

    [Description("Hostname or IP address of the Modbus TCP device.")]
    public string Host { get; set; } = "";

    [DefaultValue(502)]
    [Description("TCP port the device listens on (Modbus TCP default 502; RS485-to-Ethernet gateways often use 4196, 8899, or 502).")]
    public int Port { get; set; } = 502;

    [DefaultValue("tcp")]
    [Description("Wire protocol: 'tcp' (native Modbus TCP) or 'rtu-over-tcp' (Modbus RTU frames over a raw TCP socket). Most RS485-to-Ethernet gateways / serial dongles — e.g. an EG4 inverter reached on port 4196/8899 — speak rtu-over-tcp, not native Modbus TCP.")]
    [AllowedValues("tcp", "rtu-over-tcp")]
    public string Framing { get; set; } = "tcp";

    [DefaultValue(1)]
    [Description("Modbus unit / slave id.")]
    public int UnitId { get; set; } = 1;

    [DefaultValue(10)]
    [Range(1, 86400, ErrorMessage = "PollIntervalSeconds must be between 1 and 86400.")]
    [Description("How often to poll this device, in seconds.")]
    public int PollIntervalSeconds { get; set; } = 10;

    [DefaultValue(true)]
    [Description("Poll this device. Turn off to disable it without deleting the connection.")]
    public bool Enabled { get; set; } = true;
}
