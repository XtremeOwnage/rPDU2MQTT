using rPDU2MQTT.Models.Config.Schemas;
using System.ComponentModel;
using System.Text.Json.Serialization;
using YamlDotNet.Serialization;

namespace rPDU2MQTT.Models.Config;

/// <summary>
/// Configuration settings for the PDU.
/// </summary>
public class PduConfig
{
    /// <summary>
    /// Gets or sets the connection details for MQTT Broker.
    /// </summary>
    [Required(ErrorMessage = "Connection is required")]
    [Display(Description = "Connection details for PDU")]
    public Connection Connection { get; set; } = new Connection();

    /// <summary>
    /// Credentials used when connection to PDU.
    /// </summary>
    [YamlMember(Alias = "Credentials", DefaultValuesHandling = DefaultValuesHandling.OmitNull)]
    [Display(Description = "PDU login used for write actions (outlet control). Can also be supplied via RPDU2MQTT_PDU_USERNAME / RPDU2MQTT_PDU_PASSWORD.")]
    [DefaultValue(null)]
    public Schemas.Credentials? Credentials { get; set; } = null;

    /// <summary>
    /// Gets or sets the polling interval for the PDU in seconds.
    /// </summary>
    [Range(1, int.MaxValue, ErrorMessage = "PollInterval must be greater than 0.")]
    [Display(Name = "Poll Interval (seconds)", Description = "How often (seconds) to poll the PDU and publish readings.")]
    [DefaultValue(5)]
    public int PollInterval { get; set; } = 5;

    [DefaultValue(false)]
    [YamlMember(Alias = "ActionsEnabled", DefaultValuesHandling = DefaultValuesHandling.OmitNull, Description = "Allow the bridge to make changes on the PDU (e.g. toggle outlets). When off, no switches or other write controls are exposed to Home Assistant. Requires PDU credentials.")]
    [Display(Name = "Enable Write Actions", Description = "Allow the bridge to make changes on the PDU (e.g. toggle outlets). When off, no switches or other write controls are exposed to Home Assistant. Requires PDU credentials.")]
    public bool ActionsEnabled { get; set; }

    /// <summary>
    /// Backwards-compatible alias for <see cref="ActionsEnabled"/>; applied during config load.
    /// Hidden from the GUI/JSON (the YAML loader still honours it for compatibility).
    /// </summary>
    [JsonIgnore]
    [YamlMember(Alias = "Enable_Actions", DefaultValuesHandling = DefaultValuesHandling.OmitNull)]
    public bool? EnableActionsAlias { get; set; }

    [DefaultValue(false)]
    [YamlMember(Alias = "RemapModel", DefaultValuesHandling = DefaultValuesHandling.OmitNull, Description = "Replace each outlet/group's Model (shown in the Home Assistant device info) with contextual text (e.g. parent PDU + name) instead of the PDU's hardware model.")]
    [Display(Name = "Remap Model column", Description = "Replace each outlet/group's Model (in Home Assistant device info) with contextual text instead of the PDU's hardware model.")]
    public bool RemapModel { get; set; }

    [DefaultValue(false)]
    [YamlMember(Alias = "RemapMake", DefaultValuesHandling = DefaultValuesHandling.OmitNull, Description = "Replace each entity's Manufacturer (shown in Home Assistant) with the entity type (Outlet, Group, etc.) instead of the hardware manufacturer.")]
    [Display(Name = "Remap Manufacturer column", Description = "Replace each entity's Manufacturer (in Home Assistant) with the entity type (Outlet, Group, etc.) instead of the hardware manufacturer.")]
    public bool RemapManufacturer { get; set; }
}