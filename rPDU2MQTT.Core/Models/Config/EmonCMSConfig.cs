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
/// Auto-provisioning of EmonCMS feeds (#163): create a feed per selected measurement, log the matching
/// input into it, and keep the feed's name in sync when the source is renamed. Uses only EmonCMS's stable
/// feed API (feed/list, feed/create, feed/set) plus input/process/set with the canonical log_to_feed process.
/// </summary>
public class EmonCmsFeedsConfig
{
    [DefaultValue(false)]
    [Description("Create and maintain EmonCMS feeds from the exported inputs.")]
    public bool AutoConfigure { get; set; }

    /// <summary>Measurement types to create feeds for (empty = the defaults). PDU type names, e.g. realpower, energy.</summary>
    [Description("Measurement types to create feeds for (the raw PDU type names). Power = realpower, Energy = the native kWh reading. Add voltage/frequency/current to log those too.")]
    public List<string> Types { get; set; } = new() { "realpower", "energy" };

    [DefaultValue(EmonCmsFeedEngine.PHPFina)]
    [Description("Feed storage engine. PHPFina = fixed-interval time series (default), PHPTimeSeries = variable interval, MySQL = MySQL storage.")]
    public EmonCmsFeedEngine Engine { get; set; } = EmonCmsFeedEngine.PHPFina;

    [DefaultValue(10)]
    [Range(1, 86400, ErrorMessage = "Interval must be between 1 and 86400 seconds.")]
    [Description("Sample interval in seconds for a fixed-interval (PHPFina) feed.")]
    public int IntervalSeconds { get; set; } = 10;

    /// <summary>The EmonCMS "tag" (group) the feeds are filed under. Blank uses the input node name.</summary>
    [Description("The EmonCMS tag (group) new feeds are filed under. Blank uses the input node name.")]
    public string? Tag { get; set; }

    /// <summary>
    /// Template for a feed's name. Placeholders match the input template, but {name} (the source's display
    /// name) makes renames flow through: rename the outlet and the feed is renamed to match.
    /// </summary>
    [DefaultValue("{name} {type}")]
    [Description("Template for feed names. Placeholders: {device}, {source} (object-id form), {name} (display name), {number} (outlet number), {type}, {units}. Using {name} lets a rename of the source rename its feed. e.g. '{name} {type}'.")]
    [TemplateVariables("device", "source", "name", "number", "type", "units")]
    public string FeedNameTemplate { get; set; } = "{name} {type}";
}
