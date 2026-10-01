using System.ComponentModel;
using System.ComponentModel.DataAnnotations;
using System.Text.Json.Serialization;

namespace rPDU2MQTT.Plugin.Tigo;

/// <summary>The plugin's settings, stored under <c>Plugins: tigo:</c> and drawn as its settings page.</summary>
public sealed class TigoSettings
{
    [DefaultValue(false)]
    [Description("Read Tigo TS4 optimizers from a TAP's RS485 bus.")]
    public bool Enabled { get; set; }

    [Description("The TAP buses to read, each through an RS485-to-Ethernet gateway in raw TCP mode (38400 baud, 8N1).")]
    public List<TigoConnection> Connections { get; set; } = [];

    [DefaultValue(180)]
    [Description("Seconds after an optimizer's last report that its reading is no longer current. Optimizers go quiet at night; while the TAP still answers, a quiet optimizer reads 0 W rather than nothing.")]
    public int StaleSeconds { get; set; } = 180;
}

/// <summary>One TAP bus.</summary>
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

    // A string rather than the enum: the plugin binder reads settings as JSON with no enum converter, so an
    // enum here would make a saved "Poll" fail to bind and the whole section fall back to defaults.
    [DefaultValue("Listen")]
    [Required]
    [AllowedValues("Listen", "Poll")]
    [Description("Listen: read-only beside a Tigo CCA, which does the polling; nothing is transmitted. Poll: the bridge polls the TAP itself, with no CCA on the bus. Poll mode stands down if it hears another controller.")]
    public string Mode { get; set; } = "Listen";

    /// <summary>The mode as the bus uses it; anything but "Poll" listens, the safe way to be wrong.</summary>
    [JsonIgnore]
    public TigoMode Kind => string.Equals(Mode?.Trim(), "Poll", StringComparison.OrdinalIgnoreCase) ? TigoMode.Poll : TigoMode.Listen;

    [Description("Poll mode: the TAP's gateway id in hex (e.g. 1209). Blank learns it from the bus, which needs a controller to have been talking to the TAP.")]
    public string? GatewayId { get; set; }

    [DefaultValue(1000)]
    [Description("Poll mode: milliseconds between polls of the TAP's receive queue.")]
    public int PollIntervalMs { get; set; } = 1000;

    [DefaultValue(0.0056)]
    [Description("Amps per count of the optimizer's input-current field. Leave as is unless the currents read wrong against a clamp meter.")]
    public double AmpsScale { get; set; } = TapPackets.DefaultAmpsScale;

    /// <summary>The configured gateway id, or null to learn it.</summary>
    [JsonIgnore]
    public ushort? Gateway => ushort.TryParse((GatewayId ?? "").Trim().Replace("0x", "", StringComparison.OrdinalIgnoreCase),
        System.Globalization.NumberStyles.HexNumber, null, out var v) ? v : null;
}
