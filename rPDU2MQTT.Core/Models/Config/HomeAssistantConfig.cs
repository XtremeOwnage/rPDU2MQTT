using System.ComponentModel;

namespace rPDU2MQTT.Models.Config;

/// <summary>
/// Configuration settings for Home Assistant integration.
/// </summary>
public class HomeAssistantConfig
{
    /// <summary>
    /// Gets or sets a value indicating whether Home Assistant discovery is enabled.
    /// </summary>
    [Display(Description = "Indicates whether Home Assistant discovery is enabled.")]
    public bool DiscoveryEnabled { get; set; } = false;

    /// <summary>
    /// Gets or sets the discovery topic for Home Assistant.
    /// </summary>
    [Display(Description = "The discovery topic for Home Assistant.")]
    public string? DiscoveryTopic { get; set; }

    /// <summary>
    /// How often should discovery data be published?
    /// </summary>
    /// <remarks>
    /// A value of 0, will run a single discovery, and not run a re-discovery until the application is restarted.
    /// </remarks>
    [Description("How often (seconds) to republish discovery. 0 = run once at startup until restarted.")]
    public int DiscoveryInterval { get; set; } = 0;

    /// <summary>
    /// Should discovery messages be retained?
    /// </summary>
    [Description("Whether discovery messages are retained on the broker.")]
    public bool DiscoveryRetain { get; set; } = true;

    /// <summary>
    ///  Default expireAfter interval applied to all sensors. After this time- the sensor will be marked as unavailable.
    /// </summary>
    [Description("expire_after (seconds) applied to sensors; after this long without an update Home Assistant marks them unavailable.")]
    public int SensorExpireAfterSeconds { get; set; } = (int)TimeSpan.FromMinutes(5).TotalSeconds;

    /// <summary>
    /// Name template for the member-outlet switches mirrored onto a OneView group's device.
    /// Placeholders: {device}, {outlet}, {number}, {group}.
    /// </summary>
    [DefaultValue("{device} — Outlet {number} ({outlet})")]
    [Description("Name template for a group's mirrored member switches. Placeholders: {device}, {outlet}, {number}, {group}.")]
    [TemplateVariables("device", "outlet", "number", "group")]
    public string GroupMemberNameTemplate { get; set; } = "{device} — Outlet {number} ({outlet})";

    /// <summary>
    /// Stable entity/object_id template for a group's mirrored member switches. Defaults to the PDU
    /// serial + outlet number so it doesn't change when names/labels do. Lower-cased + slugified.
    /// Placeholders: {serial}, {number}, {device}, {group}.
    /// </summary>
    [DefaultValue("{serial}_outlet_{number}")]
    [Description("Stable entity/object_id template for a group's mirrored member switches. Placeholders: {serial}, {number}, {device}, {group}.")]
    [TemplateVariables("serial", "number", "device", "group")]
    public string GroupMemberObjectIdTemplate { get; set; } = "{serial}_outlet_{number}";

    /// <summary>Auto-configure HA's Energy Dashboard device hierarchy from the energy flow (#128).</summary>
    [Description("Auto-configure Home Assistant's Energy Dashboard 'devices' (with upstream relationships) from the energy-flow hierarchy, via HA's WebSocket API.")]
    public HomeAssistantEnergyDashboardConfig EnergyDashboard { get; set; } = new();
}

/// <summary>
/// Pushes the energy-flow hierarchy into Home Assistant's Energy Dashboard "individual devices" — each
/// tier's energy stat plus its upstream device (<c>included_in_stat</c>, which prevents double-counting) —
/// via HA's WebSocket API (this can't be done over MQTT discovery). See #128.
/// </summary>
public class HomeAssistantEnergyDashboardConfig
{
    [DefaultValue(false)]
    [Description("Sync the energy-flow hierarchy into HA's Energy Dashboard via its API. Requires Url + a long-lived access token.")]
    public bool Enabled { get; set; }

    [Description("Home Assistant base URL, e.g. http://homeassistant.local:8123 .")]
    public string? Url { get; set; }

    [Description("Home Assistant long-lived access token (or set RPDU2MQTT_HASS_TOKEN).")]
    public string? Token { get; set; }

    [DefaultValue("energy")]
    [Description("Measurement type holding each entity's cumulative energy (kWh) — used to find the Energy Dashboard stat for each tier.")]
    public string EnergyMeasurementType { get; set; } = "energy";
}