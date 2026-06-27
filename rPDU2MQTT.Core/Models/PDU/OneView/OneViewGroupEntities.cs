using rPDU2MQTT.Models.Converters;
using System.Text.Json.Serialization;

namespace rPDU2MQTT.Models.PDU.OneView;

public class OneViewGroupEntities
{
    [JsonPropertyName("outlet")]
    [JsonConverter(typeof(DictionaryToListConverter<OneViewGroupedOutlet, int>))]
    public List<OneViewGroupedOutlet> Outlets { get; set; } = new List<OneViewGroupedOutlet>();

    // pduTotal is keyed the same way as outlet (e.g. {"0": {...}}), so deserialize it as a list too.
    [JsonPropertyName("pduTotal")]
    [JsonConverter(typeof(DictionaryToListConverter<OneViewGroupedOutlet, int>))]
    public List<OneViewGroupedOutlet> PduTotal { get; set; } = new List<OneViewGroupedOutlet>();
}
