using System.Text.Json.Serialization;

namespace rPDU2MQTT.Models.PDU.OneView;

public class OneViewConf
{
    [JsonPropertyName("gdp")]
    public OneViewConfGDP Gdp { get; set; }
}
