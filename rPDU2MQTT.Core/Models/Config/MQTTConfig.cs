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
    public MqttConnection Connection { get; set; } = new MqttConnection();

    /// <summary>
    /// Gets or sets the keepalive interval for the MQTT connection in seconds.
    /// </summary>
    [Range(1, int.MaxValue, ErrorMessage = "KeepAlive must be greater than 0.")]
    [Display(Description = "The keepalive interval for the MQTT connection in seconds.")]
    public int KeepAlive { get; set; } = 60;

    /// <summary>
    /// Use an MQTT Last-Will message + availability topic so Home Assistant marks entities
    /// unavailable the moment the bridge disconnects.
    /// </summary>
    [DefaultValue(true)]
    [YamlMember(Alias = "LastWill", DefaultValuesHandling = DefaultValuesHandling.OmitNull)]
    [Display(Name = "Last Will / Availability", Description = "Publish a Last-Will message and set an availability topic on entities, so Home Assistant marks them unavailable immediately when the bridge disconnects. When off, entities instead rely on HomeAssistant.SensorExpireAfterSeconds (expire_after) to go unavailable.")]
    public bool LastWill { get; set; } = true;

    /// <summary>
    /// Whether published measurements carry the time they were read, and how (#205). The timestamp is the
    /// poll time, so a consumer can tell a fresh reading from a republished one.
    /// </summary>
    [DefaultValue(MessageTimestampMode.None)]
    [YamlMember(Alias = "MessageTimestamp", DefaultValuesHandling = DefaultValuesHandling.OmitNull)]
    [Display(Name = "Message Timestamp", Description = "Carry the time a measurement was read. 'None' (default) publishes exactly as before. 'UserProperty' adds an MQTT v5 'timestamp' property and leaves the payload alone — verify it against your broker first, since a broker or client that mishandles user properties on PUBLISH can drop the connection. 'Payload' publishes {\"value\": …, \"timestamp\": …} instead of a bare value (Home Assistant discovery adapts automatically).")]
    [AllowedValues("None", "UserProperty", "Payload")]
    public MessageTimestampMode MessageTimestamp { get; set; } = MessageTimestampMode.None;
}
