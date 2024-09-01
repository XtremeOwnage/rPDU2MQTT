using rPDU2MQTT.Models.Config.Schemas;
using System.ComponentModel;
using YamlDotNet.Serialization;

namespace rPDU2MQTT.Models.Config;

/// <summary>
/// Configuration settings for the MQTT broker.
/// </summary>
[YamlSerializable]
public class MQTTConfig
{
    [YamlMember(Alias = "Credentials", DefaultValuesHandling = DefaultValuesHandling.OmitNull, Description = "Optional credentials to connect to MQTT")]
    public Schemas.Credentials? Credentials { get; set; } = null;

    /// <summary>
    /// Gets or sets the client-id for connecting to the MQTT broker.
    /// </summary>
    [Display(Description = "The client-id used when connecting to MQTT.")]
    public string ClientID { get; set; } = "rpdu2mqtt";

    /// <summary>
    /// Gets or sets the parent topic for MQTT messages.
    /// </summary>
    [Required(ErrorMessage = "ParentTopic is required.")]
    [Display(Description = "The parent topic for MQTT messages.")]
    [DefaultValue("rPDU2MQTT")]
    public string ParentTopic { get; set; } = "rPDU2MQTT";

    /// <summary>
    /// Gets or sets the connection details for MQTT Broker.
    /// </summary>
    [Required(ErrorMessage = "Connection is required")]
    [Display(Description = "Connection details for MQTT Broker")]
    public Connection Connection { get; set; } = new Connection();

    /// <summary>
    /// Gets or sets the keepalive interval for the MQTT connection in seconds.
    /// </summary>
    [Range(1, int.MaxValue, ErrorMessage = "KeepAlive must be greater than 0.")]
    [Display(Description = "The keepalive interval for the MQTT connection in seconds.")]
    public int KeepAlive { get; set; } = 60;
}
