using System.ComponentModel;

namespace rPDU2MQTT.Models.Config;

/// <summary>
/// Configuration for pushing measurements to an EmonCMS server.
/// </summary>
public class EmonCMSConfig
{
    [DefaultValue(false)]
    public bool Enabled { get; set; }

    /// <summary>Base URL of the EmonCMS server, e.g. "http://emoncms.example.com".</summary>
    public string? Url { get; set; }

    /// <summary>EmonCMS write API key (can also be supplied via RPDU2MQTT_EMONCMS_APIKEY).</summary>
    public string? ApiKey { get; set; }

    /// <summary>EmonCMS input node name.</summary>
    [DefaultValue("rpdu2mqtt")]
    public string Node { get; set; } = "rpdu2mqtt";
}
