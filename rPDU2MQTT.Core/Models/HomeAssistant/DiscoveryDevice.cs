using rPDU2MQTT.Interfaces;
using rPDU2MQTT.Models.Converters;
using rPDU2MQTT.Models.PDU.DummyDevices;
using System.Text.Json.Serialization;

namespace rPDU2MQTT.Models.HomeAssistant;

/// <summary>
/// Represents a device, which is used in discoveries.
/// </summary>
public record DiscoveryDevice
{
    [JsonPropertyName("identifiers")]
    public string UniqueIdentifier { get; set; }

    [JsonPropertyName("name")]
    public string Name { get; set; }

    [JsonPropertyName("manufacturer")]
    public string Manufacturer { get; set; }

    [JsonPropertyName("model")]
    public string Model { get; set; }

    [JsonPropertyName("serial_number")]
    public string SerialNumber { get; set; }

    [JsonPropertyName("hw_version")]
    public string HardwareVersion { get; set; }

    [JsonPropertyName("sw_version")]
    public string SoftwareVersion { get; set; }

    [JsonPropertyName("configuration_url")]
    public string ConfigurationUrl { get; set; }

    // Home Assistant device "connections": list of [type, value] pairs (e.g. ["mac","00:.."], ["ip","10..."]).
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    [JsonPropertyName("connections")]
    public List<string[]>? Connections { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull | JsonIgnoreCondition.WhenWritingDefault)]
    [JsonPropertyName("via_device")]
    [JsonConverter(typeof(DeviceToUniqueIdentifierConverter))]
    public DiscoveryDevice? ParentDevice { get; set; }

    /// <summary>
    /// Create a child device of this one.
    /// </summary>
    /// <param name="entity">The entity the child device represents.</param>
    /// <param name="prefixWithParentName">
    /// When true, prefix the child's name with this device's name (e.g. "Rack-PDU-1 Outlet 1"),
    /// so names stay unambiguous across multiple parents.
    /// </param>
    public DiscoveryDevice CreateChild(NamedEntity entity, bool prefixWithParentName = false, bool inheritConnections = false)
    {
        var name = prefixWithParentName
            ? $"{Name} {entity.Entity_DisplayName}"
            : entity.Entity_DisplayName;

        var child = this with { UniqueIdentifier = entity.Entity_Identifier, ParentDevice = this, Name = name };

        // Only the physical PDU device carries the MAC/IP connections; outlets/groups must not.
        if (!inheritConnections)
            child.Connections = null;

        return child;
    }
}
