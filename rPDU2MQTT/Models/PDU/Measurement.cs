using rPDU2MQTT.Interfaces;
using rPDU2MQTT.Models.PDU.DummyDevices;
using System.Diagnostics;
using System.Text.Json.Serialization;

namespace rPDU2MQTT.Models.PDU;

/// <summary>
/// This represents a measurement coming from Rack PDU.
/// </summary>
[DebuggerDisplay("Measurement: {Type} {Value} {Units}")]
public partial class Measurement : NamedEntity
{
    [JsonPropertyName("type")]
    public string Type { get; set; }

    [JsonPropertyName("value")]
    public string Value { get; set; }

    [JsonPropertyName("displayEnabled")]
    public bool DisplayEnabled { get; set; }

    [JsonPropertyName("datalogEnabled")]
    public bool DatalogEnabled { get; set; }

    [JsonPropertyName("state")]
    public string State { get; set; }

    [JsonPropertyName("units")]
    public string Units { get; set; }

    [JsonPropertyName("alarm")]
    public A0Ae260C851900C3Alarm Alarm { get; set; }
}
