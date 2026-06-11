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

    /// <summary>Base URL of the EmonCMS server, e.g. "http://emoncms.example.com".</summary>
    [Description("Base URL of the EmonCMS server, e.g. http://emoncms.example.com.")]
    public string? Url { get; set; }

    /// <summary>EmonCMS write API key (can also be supplied via RPDU2MQTT_EMONCMS_APIKEY).</summary>
    [Description("EmonCMS write API key (or set RPDU2MQTT_EMONCMS_APIKEY).")]
    public string? ApiKey { get; set; }

    /// <summary>EmonCMS input node name.</summary>
    [DefaultValue("rpdu2mqtt")]
    [Description("EmonCMS input node name.")]
    public string Node { get; set; } = "rpdu2mqtt";

    /// <summary>API path (relative to <see cref="Url"/>) that measurements are posted to.</summary>
    [DefaultValue("input/post")]
    [Description("API path (relative to Url) that measurements are posted to.")]
    public string Path { get; set; } = "input/post";
}
