using System.ComponentModel;
using System.ComponentModel.DataAnnotations;
using System.Text.Json.Serialization;

namespace rPDU2MQTT.Plugin.Tigo;

public sealed class TigoSettings
{
    [DefaultValue(false)]
    [Description("Read Tigo TS4 optimizers from a TAP's RS485 bus.")]
    public bool Enabled { get; set; }

    [Description("The TAP buses to read, each through an RS485-to-Ethernet gateway in raw TCP mode (38400 baud, 8N1).")]
    public List<TigoConnection> Connections { get; set; } = [];

    [DefaultValue(180)]
    [Description("Seconds after an optimizer's last report before its reading is stale.")]
    public int StaleSeconds { get; set; } = 180;
}

public sealed class TigoConnection
{
    [Description("Stable id for this bus, e.g. 'roof'.")]
    public string Id { get; set; } = "";

    [Description("Friendly name.")]
    public string? Name { get; set; }

    [DefaultValue(true)]
    [Description("Read this bus.")]
    public bool Enabled { get; set; } = true;

    [Description("The RS485-to-Ethernet gateway's address.")]
    public string Host { get; set; } = "";

    [DefaultValue(4196)]
    [Description("Its raw TCP port (Waveshare's default is 4196; USR-TCP232's 8899).")]
    public int Port { get; set; } = 4196;

    // String, not enum: the plugin binder has no enum converter.
    [DefaultValue("Listen")]
    [Required]
    [AllowedValues("Listen", "Poll")]
    [Description("Listen: read-only beside a Tigo CCA. Poll: the bridge polls the TAP itself, with no CCA on the bus.")]
    public string Mode { get; set; } = "Listen";

    /// <summary>Anything but "Poll" listens.</summary>
    [JsonIgnore]
    public TigoMode Kind => string.Equals(Mode?.Trim(), "Poll", StringComparison.OrdinalIgnoreCase) ? TigoMode.Poll : TigoMode.Listen;

    [Description("Poll mode: the TAP's gateway id in hex (e.g. 1209). Blank learns it from the bus.")]
    public string? GatewayId { get; set; }

    [DefaultValue(1000)]
    [Description("Poll mode: milliseconds between polls of the TAP's receive queue.")]
    public int PollIntervalMs { get; set; } = 1000;

    [DefaultValue(0.0056)]
    [Description("Amps per count of the optimizer's input-current field.")]
    public double AmpsScale { get; set; } = TapPackets.DefaultAmpsScale;

    [JsonIgnore]
    public ushort? Gateway => ushort.TryParse((GatewayId ?? "").Trim().Replace("0x", "", StringComparison.OrdinalIgnoreCase),
        System.Globalization.NumberStyles.HexNumber, null, out var v) ? v : null;
}
