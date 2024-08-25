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

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull | JsonIgnoreCondition.WhenWritingDefault)]
    [JsonPropertyName("via_device")]
    [JsonConverter(typeof(DeviceToUniqueIdentifierConverter))]
    public DiscoveryDevice? ParentDevice { get; set; }

    public DiscoveryDevice CreateChild(NamedEntity entity)
    {
        return this with { UniqueIdentifier = entity.Entity_Identifier, ParentDevice = this, Name = entity.Entity_DisplayName };
    }
}
