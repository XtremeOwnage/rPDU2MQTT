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
    [Description("Template for EmonCMS input keys. Placeholders: {device}, {source} (a.k.a. {outlet}), {type}, {units}. e.g. '{device}_{source}_{type}' -> rack_pdu_1_dell_md1200_realpower. Leave blank to use the full raw identifier.")]
    [TemplateVariables("device", "source", "type", "units")]
    public string InputNameTemplate { get; set; } = "{device}_{source}_{type}";

    /// <summary>Base MQTT topic for EmonCMS's MQTT input (the Mqtt transport publishes to base/node).</summary>
    [DefaultValue("emon")]
    [Description("Base MQTT topic for EmonCMS's MQTT input; values are published to <base>/<node> as JSON. (Mqtt transport.)")]
    public string MqttBaseTopic { get; set; } = "emon";
}
