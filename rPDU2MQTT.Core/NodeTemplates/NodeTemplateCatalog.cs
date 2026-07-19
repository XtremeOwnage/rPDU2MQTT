namespace rPDU2MQTT.NodeTemplates;

/// <summary>
/// The built-in energy-flow device templates offered by the GUI's "Import device template". Add a new
/// device by appending a <see cref="NodeTemplate"/> here; the GUI picks it up from
/// <c>/api/node-templates</c> automatically.
/// </summary>
public static class NodeTemplateCatalog
{
    public static IReadOnlyList<NodeTemplate> All { get; } = new[]
    {
        Eg4FlexBoss21(),
    };

    /// <summary>
    /// EG4 FlexBoss 21 hybrid inverter over Modbus. Register map from the community ESPHome config
    /// (snarfattack/ESPHome_EG4-BOSS). EG4/LuxPower maps vary by model and firmware — verify addresses and
    /// scales against your unit; this is a head start, not a guarantee.
    /// </summary>
    private static NodeTemplate Eg4FlexBoss21() => new(
        Id: "eg4-flexboss21",
        Name: "EG4 FlexBoss 21",
        Vendor: "EG4",
        Description: "EG4 FlexBoss 21 hybrid inverter (Modbus TCP / RS485 dongle). Creates a Modbus connection plus solar, battery, grid and inverter nodes wired into the inverter. Register map is a community starting point — verify against your firmware.",
        SourceUrl: "https://github.com/snarfattack/ESPHome_EG4-BOSS/blob/main/flexboss21.yaml",
        Transport: NodeTemplate.ModbusTransport,
        Modbus: new ModbusConnectionTemplate(Port: 502, UnitId: 1, PollIntervalSeconds: 10),
        Nodes: new[]
        {
            new TemplateNode("inverter", "EG4 FlexBoss 21", "inverter", new[]
            {
                new TemplateSource("realpower", "W", 1.0, Register: 24, RegisterType: "input", DataType: "uint16",
                    Note: "EPS / load output power (input reg 24)."),
            }),
            new TemplateNode("solar", "Solar (PV)", "solar", new[]
            {
                new TemplateSource("realpower", "W", 1.0, Register: 7, RegisterType: "input", DataType: "uint16",
                    Note: "PV1 power (input reg 7). PV is split across strings (reg 7/8/9) — add PV2/PV3 nodes if you use them."),
                new TemplateSource("energy", "kWh", 0.1, Register: 40, RegisterType: "input", DataType: "uint32", WordOrder: "little",
                    Note: "PV total energy (input reg 40, 32-bit, word-swapped, x0.1 kWh)."),
            }, FeedsKey: "inverter"),
            new TemplateNode("battery", "Battery", "battery", new[]
            {
                new TemplateSource("realpower", "W", 1.0, Register: 11, RegisterType: "input", DataType: "uint16",
                    Note: "Battery discharge power (input reg 11). Charge power is a separate register (reg 10)."),
                new TemplateSource("voltage", "V", 0.1, Register: 4, RegisterType: "input", DataType: "uint16",
                    Note: "Battery voltage (input reg 4, x0.1 V)."),
            }, FeedsKey: "inverter"),
            new TemplateNode("grid", "Grid", "grid", new[]
            {
                new TemplateSource("realpower", "W", 1.0, Register: 27, RegisterType: "input", DataType: "uint16",
                    Note: "Grid import power (input reg 27). Export is a separate register (reg 26)."),
            }, FeedsKey: "inverter"),
        });
}
