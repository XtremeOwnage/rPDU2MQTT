using Microsoft.Extensions.Options;
using rPDU2MQTT.Models.Config;

namespace rPDU2MQTT.Classes;

public class Config
{
    public Config(IOptionsSnapshot<MQTTConfig> MQTT, IOptionsSnapshot<PduConfig> PDU, IOptionsSnapshot<HomeAssistantConfig> HASS, IOptionsSnapshot<Overrides> Overrides)
    {
        this.MQTT = MQTT.Value;
        this.PDU = PDU.Value;
        this.HASS = HASS.Value;
        this.Overrides = Overrides.Value;
    }

    public MQTTConfig MQTT { get; }
    public PduConfig PDU { get; }
    public HomeAssistantConfig HASS { get; }

    public Overrides Overrides { get; }
}
