using rPDU2MQTT.Models.Config;
using System.Text.Json.Serialization;
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
    [JsonPropertyName("HomeAssistant")]
    public HomeAssistantConfig HASS { get; set; } = new HomeAssistantConfig();

    [YamlMember(Alias = "Overrides", DefaultValuesHandling = DefaultValuesHandling.OmitDefaults, Description = "Overrides")]
    public Overrides Overrides { get; set; } = new Overrides();

    [YamlMember(Alias = "Debug", DefaultValuesHandling = DefaultValuesHandling.OmitDefaults, Description = "Settings for debugging and diagnostics.")]
    public DebugConfig Debug { get; set; } = new DebugConfig();

    [YamlMember(Alias = "Prometheus", DefaultValuesHandling = DefaultValuesHandling.OmitDefaults, Description = "Prometheus metrics exporter")]
    public PrometheusConfig Prometheus { get; set; } = new PrometheusConfig();

    [YamlMember(Alias = "EmonCMS", DefaultValuesHandling = DefaultValuesHandling.OmitDefaults, Description = "EmonCMS exporter")]
    public EmonCMSConfig EmonCMS { get; set; } = new EmonCMSConfig();

    [YamlMember(Alias = "Logging")]
    public LoggingConfig Logging { get; set; } = new LoggingConfig();

    [YamlMember(Alias = "Gui", DefaultValuesHandling = DefaultValuesHandling.OmitDefaults, Description = "Embedded configuration web GUI")]
    public GuiConfig Gui { get; set; } = new GuiConfig();

    [YamlMember(Alias = "Health", DefaultValuesHandling = DefaultValuesHandling.OmitDefaults, Description = "HTTP health-check endpoints")]
    public HealthConfig Health { get; set; } = new HealthConfig();
}
