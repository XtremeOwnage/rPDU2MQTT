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

    /// <summary>
    /// The PDU instances to bridge, keyed by instance name. Each is polled independently and its data
    /// published to MQTT/exporters. (v2 replaced the single <c>PDU</c> section with this map.)
    /// </summary>
    [YamlMember(Alias = "Pdus", DefaultValuesHandling = DefaultValuesHandling.OmitDefaults, Description = "PDU instances to bridge, keyed by instance name.")]
    public Dictionary<string, PduConfig> Pdus { get; set; } = new();

    /// <summary>Instance key used for a single/primary PDU.</summary>
    public const string DefaultInstanceKey = "default";

    /// <summary>
    /// Deprecated v1 single-PDU section. Captured only so an existing <c>PDU:</c> config auto-migrates
    /// to a one-entry <see cref="Pdus"/> map (key <see cref="DefaultInstanceKey"/>) during load; it is
    /// cleared afterwards and never re-serialised. Hidden from the GUI/JSON schema — use <see cref="Pdus"/>.
    /// </summary>
    [JsonIgnore]
    [YamlMember(Alias = "PDU", DefaultValuesHandling = DefaultValuesHandling.OmitNull)]
    public PduConfig? PDU { get; set; }

    /// <summary>
    /// The primary instance — the one GUI control/live/discovery operate on, and the source of the
    /// cross-cutting settings (poll cadence, write actions, model/manufacturer remap). It's the
    /// <see cref="DefaultInstanceKey"/> entry if present, else the first configured instance.
    /// </summary>
    [JsonIgnore]
    [YamlIgnore]
    public PduConfig Primary =>
        Pdus.TryGetValue(DefaultInstanceKey, out var p) ? p! : (Pdus.Values.FirstOrDefault() ?? new PduConfig());

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

    [YamlMember(Alias = "Api", DefaultValuesHandling = DefaultValuesHandling.OmitDefaults, Description = "Read-only REST API + OpenAPI/Scalar docs")]
    public ApiConfig Api { get; set; } = new ApiConfig();

    [YamlMember(Alias = "EnergyFlow", DefaultValuesHandling = DefaultValuesHandling.OmitDefaults, Description = "Virtual upstream nodes (breakers, transfer switches, a “Total”) and their feeder wiring for the energy-flow hierarchy. Edited visually on the Flow tab.")]
    public EnergyFlowConfig EnergyFlow { get; set; } = new EnergyFlowConfig();

    /// <summary>
    /// Replace this instance's settings with another's. Used to hot-reload the shared singleton on
    /// rediscovery (services read these sections live). Connection-level settings (MQTT/PDU host/port,
    /// GUI/Health ports, command-topic filters) are bound at startup and still require a restart.
    /// </summary>
    public void CopyFrom(Config other)
    {
        MQTT = other.MQTT;
        Pdus = other.Pdus;
        HASS = other.HASS;
        Overrides = other.Overrides;
        Debug = other.Debug;
        Prometheus = other.Prometheus;
        EmonCMS = other.EmonCMS;
        Logging = other.Logging;
        Gui = other.Gui;
        Health = other.Health;
        Api = other.Api;
        EnergyFlow = other.EnergyFlow;
    }
}
