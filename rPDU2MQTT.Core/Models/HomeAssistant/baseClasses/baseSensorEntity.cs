using rPDU2MQTT.Models.Converters;
using rPDU2MQTT.Models.HomeAssistant.DiscoveryTypes;
using System.Text.Json.Serialization;

namespace rPDU2MQTT.Models.HomeAssistant.baseClasses;

public class baseSensorEntity : baseEntity
{
    /// <summary>
    /// If set, it defines the number of seconds after the sensor’s state expires, if it’s not updated. 
    /// After expiry, the sensor’s state becomes unavailable. Default the sensors state never expires.
    /// </summary>
    [JsonPropertyName("expire_after")]
    public TimeSpan? ExpireAfter { get; set; } = TimeSpan.FromMinutes(5);

    /// <summary>
    /// Sends update events (which results in update of state object’s last_changed) even if the sensor’s state hasn’t changed.
    /// Useful if you want to have meaningful value graphs in history or want to create an automation that triggers on every incoming state message.
    /// </summary>
    [JsonPropertyName("force_update")]
    public bool? ForceUpdate { get; set; } = false;
}
