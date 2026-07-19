namespace rPDU2MQTT.NodeTemplates;

/// <summary>
/// A ready-made energy-flow device template (#210 follow-up): importing one drops a set of pre-wired
/// <c>EnergyFlow</c> nodes (and, for Modbus devices, a <c>Modbus</c> connection) into the config, with the
/// per-metric register/topic bindings already filled in — so a known device (an EG4 inverter, a meter…)
/// doesn't have to be wired register-by-register by hand. The GUI fetches the catalogue and instantiates a
/// chosen template client-side; the user then reviews and saves.
/// <para>
/// Register maps are community-sourced starting points (see <see cref="SourceUrl"/>) and can vary by model
/// and firmware — the import is a head start to verify against the device, not a guarantee.
/// </para>
/// </summary>
public sealed record NodeTemplate(
    string Id,
    string Name,
    string Vendor,
    string Description,
    string SourceUrl,
    string Transport,
    ModbusConnectionTemplate? Modbus,
    IReadOnlyList<TemplateNode> Nodes)
{
    /// <summary>Modbus-device templates need a connection created alongside the nodes.</summary>
    public const string ModbusTransport = "modbus";
    public const string MqttTransport = "mqtt";
}

/// <summary>Defaults for the Modbus connection an imported Modbus template creates (host is prompted).</summary>
public sealed record ModbusConnectionTemplate(int Port = 502, int UnitId = 1, int PollIntervalSeconds = 10, string Framing = "auto");

/// <summary>
/// One node the template contributes. <see cref="Key"/> is a short suffix appended to the user-chosen id
/// prefix so a template can be imported more than once without id clashes; <see cref="FeedsKey"/> wires a
/// link from this node into another template node (e.g. solar → inverter).
/// </summary>
public sealed record TemplateNode(
    string Key,
    string Label,
    string Kind,
    IReadOnlyList<TemplateSource> Sources,
    string? FeedsKey = null);

/// <summary>
/// One metric binding on a template node. Mirrors the fields of <c>EnergyFlowSource</c> so the GUI can turn
/// it straight into a source (Modbus register or MQTT topic) pointing at the created connection.
/// </summary>
public sealed record TemplateSource(
    string Metric,
    string? Unit = null,
    double Scale = 1.0,
    // Modbus fields
    int Register = 0,
    string RegisterType = "holding",
    string DataType = "uint16",
    string WordOrder = "big",
    // MQTT fields
    string? Topic = null,
    string? JsonField = null,
    string? Note = null);
