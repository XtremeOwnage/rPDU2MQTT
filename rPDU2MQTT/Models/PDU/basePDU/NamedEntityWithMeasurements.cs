using rPDU2MQTT.Interfaces;
using rPDU2MQTT.Models.PDU.basePDU;
using System.Text.Json.Serialization;

namespace rPDU2MQTT.Models.PDU.DummyDevices;

/// <summary>
/// This is a class, which has a name, label, and measurements.
/// </summary>
public class NamedEntityWithMeasurements : EntityWithNameAndLabel
{
    [JsonPropertyName("measurement")]
    public Dictionary<string, Measurement> Measurements { get; set; }
}
