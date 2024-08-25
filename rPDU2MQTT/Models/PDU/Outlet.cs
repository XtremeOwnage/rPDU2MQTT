using rPDU2MQTT.Interfaces;
using rPDU2MQTT.Models.PDU.DummyDevices;
using System.Text.Json.Serialization;

namespace rPDU2MQTT.Models.PDU;

[System.Diagnostics.DebuggerDisplay("Outlet: { EntityName }")]
public partial class Outlet : NamedEntityWithMeasurements, IEntityWithState
{
    [JsonPropertyName("poaAction")]
    public string PoaAction { get; set; }

    [JsonPropertyName("rebootHoldDelay")]
    public long RebootHoldDelay { get; set; }

    [JsonPropertyName("rebootDelay")]
    public long RebootDelay { get; set; }

    [JsonPropertyName("poaDelay")]
    public double PoaDelay { get; set; }

    [JsonPropertyName("onDelay")]
    public long OnDelay { get; set; }

    [JsonPropertyName("mode")]
    public string Mode { get; set; }

    [JsonPropertyName("alarm")]
    public A0Ae260C851900C3Alarm Alarm { get; set; }

    [JsonPropertyName("timeToAction")]
    public long TimeToAction { get; set; }

    [JsonPropertyName("offDelay")]
    public long OffDelay { get; set; }

    [JsonPropertyName("state")]
    public string State { get; set; }

    [JsonPropertyName("parent")]
    public string Parent { get; set; }

    [JsonPropertyName("relayFailure")]
    public bool RelayFailure { get; set; }

    [JsonPropertyName("parentBreaker")]
    public string ParentBreaker { get; set; }

    [JsonPropertyName("parentPhase")]
    public string ParentPhase { get; set; }
}
