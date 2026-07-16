using System.ComponentModel;

namespace rPDU2MQTT.Models.Config;

/// <summary>
/// Configuration for pushing measurements to an EmonCMS server.
/// </summary>
public class EmonCMSConfig
{
    [DefaultValue(false)]
    [Description("Push measurements to an EmonCMS server.")]
    public bool Enabled { get; set; }

    [DefaultValue(EmonCmsTransport.Http)]
    [Description("How to deliver measurements: Http (input/post API) or Mqtt (publish to EmonCMS's MQTT input on the same broker).")]
    public EmonCmsTransport Transport { get; set; } = EmonCmsTransport.Http;

    /// <summary>Base URL of the EmonCMS server, e.g. "http://emoncms.example.com".</summary>
    [Description("Base URL of the EmonCMS server, e.g. http://emoncms.example.com. (Http transport.)")]
    public string? Url { get; set; }

    /// <summary>EmonCMS write API key (can also be supplied via RPDU2MQTT_EMONCMS_APIKEY).</summary>
    [Description("EmonCMS write API key (or set RPDU2MQTT_EMONCMS_APIKEY). (Http transport.)")]
    public string? ApiKey { get; set; }

    /// <summary>EmonCMS input node name.</summary>
    [DefaultValue("rpdu2mqtt")]
    [Description("EmonCMS input node name.")]
    public string Node { get; set; } = "rpdu2mqtt";

    /// <summary>API path (relative to <see cref="Url"/>) that measurements are posted to.</summary>
    [DefaultValue("input/post")]
    [Description("API path (relative to Url) that measurements are posted to. (Http transport.)")]
    public string Path { get; set; } = "input/post";

    /// <summary>
    /// Template for the EmonCMS input key (per measurement). Placeholders: {device}, {source}/{outlet},
    /// {type}, {units}. When blank, the full generated identifier is used (legacy behaviour).
    /// </summary>
    [DefaultValue("{device}_{source}_{type}")]
    [Description("Template for EmonCMS input keys. Placeholders: {device}, {source} (object-id form), {name} (formatted display name), {number} (outlet number), {type}, {units}. e.g. '{device}_{source}_{type}' -> rack_pdu_1_dell_md1200_realpower. Leave blank to use the full raw identifier.")]
    [TemplateVariables("device", "source", "name", "number", "type", "units")]
    public string InputNameTemplate { get; set; } = "{device}_{source}_{type}";

    /// <summary>Base MQTT topic for EmonCMS's MQTT input (the {base} placeholder of MqttTopicTemplate).</summary>
    [DefaultValue("emon")]
    [Description("Base MQTT topic for EmonCMS's MQTT input (the {base} placeholder of MqttTopicTemplate). (Mqtt transport.)")]
    public string MqttBaseTopic { get; set; } = "emon";

    /// <summary>
    /// Template for the EmonCMS MQTT topic each JSON payload is published to. Including <c>{device}</c>
    /// splits the export so each PDU goes to its own topic instead of one combined payload (#165).
    /// </summary>
    [DefaultValue("{base}/{node}")]
    [Description("Template for the EmonCMS MQTT topic each JSON payload is published to. Placeholders: {base} (MqttBaseTopic), {node}, {device} (the PDU's name). Including {device} splits the export so each PDU publishes to its own topic instead of one combined payload, e.g. '{base}/{node}/{device}'. (Mqtt transport.)")]
    [TemplateVariables("base", "node", "device")]
    public string MqttTopicTemplate { get; set; } = "{base}/{node}";

    [Description("Automatically create and maintain EmonCMS feeds from the exported inputs. (Http transport; needs a read/write API key.)")]
    public EmonCmsFeedsConfig Feeds { get; set; } = new();
}

/// <summary>
/// Auto-provisioning of EmonCMS feeds (#163). Per measurement type, create a storage feed and set the
/// input's processlist (log_to_feed, plus kWh→kWh/d for a daily energy feed). Storage feeds are named
/// idempotently (stable ids) so they don't churn on a source rename; optional virtual feeds carry the
/// friendly display name and source from those stable feeds. Changes take effect live (no restart).
/// </summary>
public class EmonCmsFeedsConfig
{
    [DefaultValue(false)]
    [Description("Create and maintain EmonCMS feeds from the exported inputs (takes effect without a restart).")]
    public bool AutoConfigure { get; set; }

    /// <summary>Per-type feed configuration (engine, interval, processing) — one entry per measurement type.</summary>
    [Description("The measurement types to build feeds for, each with its own engine, interval and processing.")]
    public List<EmonCmsFeedTypeConfig> Types { get; set; } = new()
    {
        new() { Type = "realpower" },
        new() { Type = "energy" },
    };

    [DefaultValue(true)]
    [Description("Name storage feeds idempotently from stable ids (device/source/type) so they DON'T change when a source is renamed. Turn off to name them from the display name instead (renaming a source renames its feed).")]
    public bool IdempotentNames { get; set; } = true;

    /// <summary>The EmonCMS "tag" (group) feeds are filed under. Blank uses the input node name.</summary>
    [Description("The EmonCMS tag (group) new feeds are filed under. Blank uses the input node name.")]
    public string? Tag { get; set; }

    [DefaultValue("{device}_{source}_{type}")]
    [Description("Template for the idempotent storage-feed name. Use only stable placeholders ({device}, {source}, {type}, {number}) so it never changes on a rename. Placeholders: {device}, {source}, {name}, {number}, {type}, {units}.")]
    [TemplateVariables("device", "source", "name", "number", "type", "units")]
    public string StorageNameTemplate { get; set; } = "{device}_{source}_{type}";

    /// <summary>Optional friendly-named feeds that source their data from the stable storage feeds (#163).</summary>
    [Description("Optionally create friendly-named virtual feeds that source from the stable storage feeds — so dashboards get nice names while the underlying feeds stay idempotent.")]
    public EmonCmsVirtualFeedsConfig Virtual { get; set; } = new();

    /// <summary>EmonCMS process ids/keys used when building processlists (instance-specific).</summary>
    [Description("EmonCMS process ids used in the generated processlists. Match these to your EmonCMS (Inputs → process dropdown).")]
    public EmonCmsProcessConfig Processes { get; set; } = new();
}

/// <summary>Per-measurement-type feed settings.</summary>
public class EmonCmsFeedTypeConfig
{
    [Description("The measurement type this applies to (raw PDU type name).")]
    [AllowedValues("realpower", "apparentpower", "energy", "current", "voltage", "frequency", "powerfactor")]
    public string Type { get; set; } = "realpower";

    [DefaultValue(EmonCmsFeedEngine.PHPFina)]
    [Description("Feed storage engine. PHPFina = fixed-interval time series (default), PHPTimeSeries = variable interval, MySQL = MySQL storage.")]
    public EmonCmsFeedEngine Engine { get; set; } = EmonCmsFeedEngine.PHPFina;

    [DefaultValue(10)]
    [Range(1, 86400, ErrorMessage = "Interval must be between 1 and 86400 seconds.")]
    [Description("Sample interval in seconds for a fixed-interval (PHPFina) feed.")]
    public int IntervalSeconds { get; set; } = 10;

    [DefaultValue(false)]
    [Description("Also create a daily kWh/d feed (an extra processlist step: kWh→kWh/d). Typically only for the energy type.")]
    public bool Daily { get; set; }

    [DefaultValue(86400)]
    [Range(1, 86400, ErrorMessage = "Interval must be between 1 and 86400 seconds.")]
    [Description("Interval (seconds) for the daily kWh/d feed. Should be a day (86400), not the base interval.")]
    public int DailyIntervalSeconds { get; set; } = 86400;
}

/// <summary>Friendly virtual feeds that source from the stable storage feeds.</summary>
public class EmonCmsVirtualFeedsConfig
{
    [DefaultValue(false)]
    [Description("Create a friendly-named virtual feed for each storage feed, sourced from it (source_feed process).")]
    public bool Enabled { get; set; }

    [DefaultValue("{name} {type}")]
    [Description("Template for the friendly virtual-feed name. {name} is the source's display name, so these can change freely without touching the stable storage feeds. Placeholders: {device}, {source}, {name}, {number}, {type}, {units}.")]
    [TemplateVariables("device", "source", "name", "number", "type", "units")]
    public string NameTemplate { get; set; } = "{name} {type}";
}

/// <summary>
/// EmonCMS process ids used in generated processlists. These are instance-specific — set them from your
/// EmonCMS (the number shown against each process in the Inputs → process editor).
/// </summary>
public class EmonCmsProcessConfig
{
    [DefaultValue("1")]
    [Description("Process id for 'Log to feed'.")]
    public string LogToFeed { get; set; } = "1";

    [Description("Process id for 'kWh to kWh/d' (used for daily energy feeds).")]
    public string? KwhToKwhd { get; set; }

    [Description("Process id for 'Source feed' (used for virtual feeds).")]
    public string? SourceFeed { get; set; }
}
