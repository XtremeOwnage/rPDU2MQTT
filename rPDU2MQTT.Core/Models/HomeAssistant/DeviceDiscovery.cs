using rPDU2MQTT.Models.HomeAssistant.baseClasses;
using System.Text.Json.Serialization;

namespace rPDU2MQTT.Models.HomeAssistant;

/// <summary>
/// A device-based MQTT discovery payload: one message describing a device and all of its
/// entities (components). See https://www.home-assistant.io/integrations/mqtt/#device-based-discovery
/// </summary>
public class DeviceDiscovery
{
    [JsonPropertyName("device")]
    public required DiscoveryDevice Device { get; init; }

    /// <summary>
    /// Identifies the application that produced this discovery (shared by all components).
    /// </summary>
    [JsonPropertyName("origin")]
    public DiscoveryOrigin Origin { get; set; } = DiscoveryOrigin.Default;

    /// <summary>
    /// The entities belonging to this device, keyed by their unique id.
    /// </summary>
    [JsonPropertyName("components")]
    public Dictionary<string, baseEntity> Components { get; set; } = new();
}
