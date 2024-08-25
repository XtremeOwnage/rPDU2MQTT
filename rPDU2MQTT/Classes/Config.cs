using Microsoft.Extensions.Options;
using rPDU2MQTT.Models.Config;

namespace rPDU2MQTT.Classes;

public class Config
{
    public Config(IOptionsSnapshot<MQTTConfig> MQTT, IOptionsSnapshot<PduConfig> PDU, IOptionsSnapshot<HomeAssistantConfig> HASS)
    {
        this.MQTT = MQTT.Value;
        this.PDU = PDU.Value;
        this.HASS = HASS.Value;
    }

    public MQTTConfig MQTT { get; }
    public PduConfig PDU { get; }
    public HomeAssistantConfig HASS { get; }
}
