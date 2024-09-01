using rPDU2MQTT.Models.Config;
using YamlDotNet.Serialization;

namespace rPDU2MQTT.Classes;

/// <summary>
/// This represents the entire configuration used for this project.
/// </summary>
public class Config
{
    [YamlMember(Alias = "MQTT", DefaultValuesHandling = DefaultValuesHandling.OmitDefaults, Description = "MQTT Configuration")]
    public MQTTConfig MQTT { get; set; } = new MQTTConfig();

    [YamlMember(Alias = "PDU", DefaultValuesHandling = DefaultValuesHandling.OmitDefaults, Description = "PDU Configuration")]
    public PduConfig PDU { get; set; } = new PduConfig();

    [YamlMember(Alias = "HomeAssistant", DefaultValuesHandling = DefaultValuesHandling.OmitDefaults, Description = "Home Assistant Configuration")]
    public HomeAssistantConfig HASS { get; set; } = new HomeAssistantConfig();

    [YamlMember(Alias = "Overrides", DefaultValuesHandling = DefaultValuesHandling.OmitDefaults, Description = "Overrides")]
    public Overrides Overrides { get; set; } = new Overrides();

    [YamlMember(Alias = "Logging")]
    public LoggingConfig Logging { get; set; } = new LoggingConfig();
}
