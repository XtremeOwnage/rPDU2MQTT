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
    [NavGroup("Integrations")]
    public MQTTConfig MQTT { get; set; } = new MQTTConfig();

    /// <summary>
    /// The PDU instances to bridge, keyed by instance name. Each is polled independently and its data
    /// published to MQTT/exporters. (v2 replaced the single <c>PDU</c> section with this map.)
    /// </summary>
    [YamlMember(Alias = "Pdus", DefaultValuesHandling = DefaultValuesHandling.OmitDefaults, Description = "PDU instances to bridge, keyed by instance name.")]
    [NavGroup("Sources")]
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

    /// <summary>PDU instances with a host set; the rest are not polled.</summary>
    [JsonIgnore]
    [YamlIgnore]
    public IEnumerable<KeyValuePair<string, PduConfig>> ConfiguredPdus =>
        Pdus.Where(kv => !string.IsNullOrWhiteSpace(kv.Value.Connection?.Host));

    [YamlMember(Alias = "HomeAssistant", DefaultValuesHandling = DefaultValuesHandling.OmitDefaults, Description = "Home Assistant Configuration")]
    [JsonPropertyName("HomeAssistant")]
    [NavGroup("Destinations")]
    public HomeAssistantConfig HASS { get; set; } = new HomeAssistantConfig();

    [YamlMember(Alias = "Overrides", DefaultValuesHandling = DefaultValuesHandling.OmitDefaults, Description = "Overrides")]
    [NavGroup("Sources")]
    public Overrides Overrides { get; set; } = new Overrides();

    [YamlMember(Alias = "Debug", DefaultValuesHandling = DefaultValuesHandling.OmitDefaults, Description = "Settings for debugging and diagnostics.")]
    public DebugConfig Debug { get; set; } = new DebugConfig();

    [YamlMember(Alias = "Prometheus", DefaultValuesHandling = DefaultValuesHandling.OmitDefaults, Description = "Prometheus metrics exporter")]
    [NavGroup("Destinations")]
    public PrometheusConfig Prometheus { get; set; } = new PrometheusConfig();

    /// <summary>Where the Flow and Energy pages read past values from (#372).</summary>
    public HistoryConfig History { get; set; } = new HistoryConfig();

    [System.ComponentModel.DataAnnotations.Display(Name = "EmonCMS")]
    [YamlMember(Alias = "EmonCMS", DefaultValuesHandling = DefaultValuesHandling.OmitDefaults, Description = "EmonCMS exporter")]
    [NavGroup("Destinations")]
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

    [YamlMember(Alias = "PlanStorage", DefaultValuesHandling = DefaultValuesHandling.OmitDefaults, Description = "Where floor plan images are kept: a directory on a persistent volume, or an S3-compatible bucket. Never the configuration itself.")]
    public PlanStorageConfig PlanStorage { get; set; } = new PlanStorageConfig();

    [YamlMember(Alias = "Modbus", DefaultValuesHandling = DefaultValuesHandling.OmitDefaults, Description = "Modbus TCP connections that energy-flow nodes can be bound to (inverters, meters, PLCs).")]
    [NavGroup("Integrations")]
    public ModbusConfig Modbus { get; set; } = new ModbusConfig();

    /// <summary>Plugin settings by plugin id, bound on load; sections of uninstalled plugins are kept.</summary>
    // Plain objects: YamlDotNet cannot construct a JsonNode.
    [YamlMember(Alias = "Plugins", DefaultValuesHandling = DefaultValuesHandling.OmitDefaults, Description = "Settings for externally loaded plugins, keyed by plugin id.")]
    public Dictionary<string, object?> Plugins { get; set; } = new();

    /// <summary>Plugins skipped at startup, by folder or DLL name; never loaded.</summary>
    [YamlMember(Alias = "DisabledPlugins", DefaultValuesHandling = DefaultValuesHandling.OmitEmptyCollections, Description = "Plugins not to load, by folder or DLL name. Restart to apply.")]
    public List<string> DisabledPlugins { get; set; } = new();

    /// <summary>Integrations of loaded plugins not to start, by integration id.</summary>
    [YamlMember(Alias = "DisabledIntegrations", DefaultValuesHandling = DefaultValuesHandling.OmitEmptyCollections, Description = "Integrations of loaded plugins not to start, by id (e.g. emoncms-source). Restart to apply.")]
    public List<string> DisabledIntegrations { get; set; } = new();

    /// <summary>Shared Redis/Valkey cache — durable state that survives restarts and is shared by replicas.</summary>
    public CacheConfig Cache { get; set; } = new CacheConfig();

    [YamlMember(Alias = "Operator", DefaultValuesHandling = DefaultValuesHandling.OmitDefaults, Description = "Kubernetes operator: let this release manage its own Deployment (registry update checks, optional self-update).")]
    public OperatorConfig Operator { get; set; } = new OperatorConfig();

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
        Plugins = other.Plugins;
        DisabledPlugins = other.DisabledPlugins;
        DisabledIntegrations = other.DisabledIntegrations;
        Modbus = other.Modbus;
        Operator = other.Operator;
        PlanStorage = other.PlanStorage;
    }
}
