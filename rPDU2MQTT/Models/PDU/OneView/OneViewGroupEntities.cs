using rPDU2MQTT.Models.Converters;
using System.Text.Json.Serialization;

namespace rPDU2MQTT.Models.PDU.OneView;

public class OneViewGroupEntities
{
    [JsonPropertyName("outlet")]
    [JsonConverter(typeof(DictionaryToListConverter<OneViewGroupedOutlet, int>))]
    public List<OneViewGroupedOutlet> Outlets { get; set; } = new List<OneViewGroupedOutlet>();

    [JsonPropertyName("pduTotal")]
    public OneViewGroupedOutlet? PduTotal { get; set; }
}
