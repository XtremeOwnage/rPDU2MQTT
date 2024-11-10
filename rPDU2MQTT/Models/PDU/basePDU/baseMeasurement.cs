using rPDU2MQTT.Models.PDU.DummyDevices;
using System.Diagnostics;
using System.Text.Json.Serialization;

namespace rPDU2MQTT.Models.PDU.basePDU;

/// <summary>
/// Base measurement class.
/// </summary>
/// <remarks>
/// This exists because <see cref="Measurement"/> exposes a DIRECT Value, while <see cref="PDU.GroupMeasurement"/> exposes Min, Avg, Max, and Sum.
/// </remarks>
[DebuggerDisplay("Measurement: {Type} {Value} {Units}")]
public class baseMeasurement : NamedEntity
{
    [JsonPropertyName("type")]
    public string Type { get; set; }

    [JsonPropertyName("displayEnabled")]
    public bool DisplayEnabled { get; set; }

    [JsonPropertyName("datalogEnabled")]
    public bool DatalogEnabled { get; set; }

    [JsonPropertyName("state")]
    public string State { get; set; }

    [JsonPropertyName("units")]
    public string Units { get; set; }

    [JsonPropertyName("alarm")]
    public Alarm Alarm { get; set; }
}
