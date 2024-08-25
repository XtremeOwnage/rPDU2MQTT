using rPDU2MQTT.Interfaces;
using rPDU2MQTT.Models.PDU.DummyDevices;
using System.Text.Json.Serialization;

namespace rPDU2MQTT.Models.PDU.basePDU;

/// <summary>
/// This entity publishes its own name, and labels.
/// </summary>
public class EntityWithNameAndLabel : NamedEntity, IEntityWithLabel
{
    [JsonPropertyName("label")]
    public string Label { get; set; }

    [JsonPropertyName("name")]
    public string Name { get; set; }
}
