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

    /// <summary>
    /// v2 multi-PDU instance set, keyed by instance name. Derived from <see cref="PDU"/> on load for now
    /// (a v1 single-PDU config migrates to a one-entry map under <see cref="DefaultInstanceKey"/>); not
    /// yet persisted or shown in the GUI. The runtime moves onto this in a later phase (#127).
    /// </summary>
    [JsonIgnore]
    [YamlIgnore]
    public Dictionary<string, PduConfig> Pdus { get; set; } = new();

    /// <summary>Instance key a migrated v1 single-PDU config is stored under.</summary>
    public const string DefaultInstanceKey = "default";

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

    /// <summary>
    /// Replace this instance's settings with another's. Used to hot-reload the shared singleton on
    /// rediscovery (services read these sections live). Connection-level settings (MQTT/PDU host/port,
    /// GUI/Health ports, command-topic filters) are bound at startup and still require a restart.
    /// </summary>
    public void CopyFrom(Config other)
    {
        MQTT = other.MQTT;
        PDU = other.PDU;
        Pdus = other.Pdus;
        HASS = other.HASS;
        Overrides = other.Overrides;
        Debug = other.Debug;
        Prometheus = other.Prometheus;
        EmonCMS = other.EmonCMS;
        Logging = other.Logging;
        Gui = other.Gui;
        Health = other.Health;
    }
}
