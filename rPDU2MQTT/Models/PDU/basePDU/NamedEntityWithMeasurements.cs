using rPDU2MQTT.Models.Converters;
using rPDU2MQTT.Models.PDU.basePDU;
using System.Text.Json.Serialization;

namespace rPDU2MQTT.Models.PDU.DummyDevices;

/// <summary>
/// This is a class, which has a name, label, and measurements.
/// </summary>
public class NamedEntityWithMeasurements : EntityWithNameAndLabel
{
    [JsonPropertyName("measurement")]
    [JsonConverter(typeof(DictionaryToListConverter<Measurement, string>))]
    public List<Measurement> Measurements { get; set; } = new();
}
