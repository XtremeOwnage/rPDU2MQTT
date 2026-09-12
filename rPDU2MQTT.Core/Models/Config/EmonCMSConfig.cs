using System.ComponentModel;

namespace rPDU2MQTT.Models.Config;

/// <summary>
/// Configuration for pushing measurements to an EmonCMS server.
/// </summary>
public class EmonCMSConfig
{
    [DefaultValue(false)]
    [Description("Push measurements to an EmonCMS server.")]
    [FeatureToggle]
    public bool Enabled { get; set; }

    [DefaultValue(EmonCmsTransport.Http)]
    [Description("How to deliver measurements: Http (input/post API) or Mqtt (publish to EmonCMS's MQTT input on the same broker).")]
    public EmonCmsTransport Transport { get; set; } = EmonCmsTransport.Http;

    /// <summary>Base URL of the EmonCMS server, e.g. "http://emoncms.example.com".</summary>
    [Description("Base URL of the EmonCMS server, e.g. http://emoncms.example.com. (Http transport.)")]
    public string? Url { get; set; }

    /// <summary>EmonCMS write API key (can also be supplied via RPDU2MQTT_EMONCMS_APIKEY).</summary>
    [Description("EmonCMS write API key (or set RPDU2MQTT_EMONCMS_APIKEY). (Http transport.)")]
    public string? ApiKey { get; set; }

    /// <summary>EmonCMS input node name.</summary>
    [DefaultValue("rpdu2mqtt")]
    [Description("EmonCMS input node name.")]
    public string Node { get; set; } = "rpdu2mqtt";

    /// <summary>API path (relative to <see cref="Url"/>) that measurements are posted to.</summary>
    [DefaultValue("input/post")]
    [Description("API path (relative to Url) that measurements are posted to. (Http transport.)")]
    public string Path { get; set; } = "input/post";

    /// <summary>
    /// Template for the EmonCMS input key (per measurement). Placeholders: {device}, {source}/{outlet},
    /// {type}, {units}. When blank, the full generated identifier is used (legacy behaviour).
    /// </summary>
    [DefaultValue("{device}_{source}_{type}")]
    [Description("Template for EmonCMS input keys. Placeholders: {device}, {source} (object-id form), {name} (formatted display name), {number} (outlet number), {type}, {units}. e.g. '{device}_{source}_{type}' -> rack_pdu_1_dell_md1200_realpower. Leave blank to use the full raw identifier.")]
    [TemplateVariables("device", "source", "name", "number", "type", "units")]
    public string InputNameTemplate { get; set; } = "{device}_{source}_{type}";

    /// <summary>
    /// Send the energy-flow hierarchy (panels, inverters, batteries, the grid — every node on the Flow tab)
    /// as inputs of its own, alongside the PDU measurements.
    ///
    /// <para>
    /// On by default: without it EmonCMS only ever received what a PDU reports, so a hierarchy someone
    /// modelled had no history recorded against it and the Flow page's "show a past moment" could never
    /// answer for those nodes — the reader has always looked for these feeds, and nothing wrote them.
    /// </para>
    /// </summary>
    [DefaultValue(true)]
    [Description("Also send each energy-flow node (panels, inverters, batteries, the grid) as its own input, not just the PDU measurements. This is what gives those nodes history to read back.")]
    public bool ExportFlowNodes { get; set; } = true;

    /// <summary>Which energy-flow nodes are sent (#342).</summary>
    [Description("Limit the exported energy-flow nodes to particular tags. Empty sends every node. Filtering changes only what is sent — never a value, and never any other destination.")]
    public NodeTagFilter NodeTags { get; set; } = new();

    /// <summary>
    /// Template for an energy-flow node's input key. Kept separate from <see cref="InputNameTemplate"/>
    /// because a tier has no device or outlet to name it after.
    /// </summary>
    [DefaultValue("{node}_{metric}")]
    [Description("Template for an energy-flow node's EmonCMS input key. Placeholders: {node} (its id), {label}, {kind}, {metric}, {units}. e.g. '{node}_{metric}' -> solar_realpower. The history reader looks feeds up by this name.")]
    [TemplateVariables("node", "label", "kind", "metric", "units")]
    public string FlowInputNameTemplate { get; set; } = "{node}_{metric}";

    /// <summary>Base MQTT topic for EmonCMS's MQTT input (the {base} placeholder of MqttTopicTemplate).</summary>
    [DefaultValue("emon")]
    [Description("Base MQTT topic for EmonCMS's MQTT input (the {base} placeholder of MqttTopicTemplate). (Mqtt transport.)")]
    public string MqttBaseTopic { get; set; } = "emon";

    /// <summary>
    /// Template for the EmonCMS MQTT topic each JSON payload is published to. Including <c>{device}</c>
    /// splits the export so each PDU goes to its own topic instead of one combined payload (#165).
    /// </summary>
    [DefaultValue("{base}/{node}")]
    [Description("Template for the EmonCMS MQTT topic each JSON payload is published to. Placeholders: {base} (MqttBaseTopic), {node}, {device} (the PDU's name). Including {device} splits the export so each PDU publishes to its own topic instead of one combined payload, e.g. '{base}/{node}/{device}'. (Mqtt transport.)")]
    [TemplateVariables("base", "node", "device")]
    public string MqttTopicTemplate { get; set; } = "{base}/{node}";

    [Description("Automatically create and maintain EmonCMS feeds from the exported inputs. (Http transport; needs a read/write API key.)")]
    public EmonCmsFeedsConfig Feeds { get; set; } = new();

    /// <summary>Reading EmonCMS the other way round — feeds as live values for energy-flow nodes.</summary>
    [Description("Read EmonCMS feeds back as live values for energy-flow nodes (bind a node's source with Type 'emoncms').")]
    public EmonCmsSourceConfig Source { get; set; } = new();
}

/// <summary>
/// EmonCMS read as a <i>source</i>: a flow node valued from a feed's current reading.
///
/// <para>
/// There is nothing to switch on here. A binding with <c>Type: emoncms</c> is the switch — the poll runs
/// when something is bound to it and not otherwise, the same rule the MQTT and Modbus ingests follow. The
/// server it reads is the one this section already describes (<c>Url</c>, <c>ApiKey</c>), because an
/// operator who has EmonCMS configured has configured it once.
/// </para>
/// </summary>
public class EmonCmsSourceConfig
{
    [DefaultValue(30)]
    [Range(5, 3600, ErrorMessage = "PollIntervalSeconds must be between 5 and 3600.")]
    [Description("How often to read the bound feeds' current values, in seconds. One request per poll however many feeds are bound.")]
    public int PollIntervalSeconds { get; set; } = 30;
}

/// <summary>
/// Auto-provisioning of EmonCMS feeds (#163). Per measurement type, create a storage feed and set the
/// input's processlist (log_to_feed, plus kWh→kWh/d for a daily energy feed). Storage feeds are named
/// idempotently (stable ids) so they don't churn on a source rename; optional virtual feeds carry the
/// friendly display name and source from those stable feeds. Changes take effect live (no restart).
/// </summary>
public class EmonCmsFeedsConfig
{
    [DefaultValue(false)]
    [Description("Create and maintain EmonCMS feeds from the exported inputs (takes effect without a restart).")]
    public bool AutoConfigure { get; set; }

    private List<EmonCmsFeedTypeConfig> types = Supported.Select(EmonCmsFeedTypeConfig.For).ToList();

    /// <summary>One entry per supported measurement type; the set is fixed, what each does is not.</summary>
    [Description("The supported measurement types. Each says whether it gets a feed, how that feed is named and stored, and whether EmonCMS derives it.")]
    [FixedList(nameof(EmonCmsFeedTypeConfig.Type))]
    public List<EmonCmsFeedTypeConfig> Types
    {
        get => types;
        // A saved config predates whatever types this build added, and the list is fixed — there is no Add
        // button to reach a missing one with. So every supported type is present after a load, in a settled
        // order, with anything already configured kept exactly as it was written.
        set => types = Complete(value);
    }

    /// <summary>The configured types, plus a default entry for every supported type not among them.</summary>
    public static List<EmonCmsFeedTypeConfig> Complete(IEnumerable<EmonCmsFeedTypeConfig>? configured)
    {
        var have = (configured ?? []).Where(t => !string.IsNullOrWhiteSpace(t?.Type)).ToList();
        var known = have.Select(t => t.Type).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var all = have.Concat(Supported.Where(t => !known.Contains(t)).Select(EmonCmsFeedTypeConfig.For));
        // Supported order first, then anything this build does not recognise, kept rather than dropped.
        return all.OrderBy(t => Supported.ToList().FindIndex(x => string.Equals(x, t.Type, StringComparison.OrdinalIgnoreCase)) is var i && i < 0 ? int.MaxValue : i)
                  .ToList();
    }

    /// <summary>The measurement types EmonCMS feeds can be built for.</summary>
    public static readonly IReadOnlyList<string> Supported =
    [
        "realpower", "energy", EnergyPeriodMetric, "apparentpower", "current", "voltage", "frequency", "powerfactor",
    ];

    /// <summary>The types something can work out, given the others. Frequency is measured or it is absent.</summary>
    public static readonly IReadOnlySet<string> Derivable = new HashSet<string>(
        ["realpower", "apparentpower", "energy", EnergyPeriodMetric, "voltage", "current", "powerfactor"],
        StringComparer.OrdinalIgnoreCase);

    /// <summary>The daily-total metric name, spelled once (see <c>Core.Flow.EnergyPeriod.Metric</c>).</summary>
    internal const string EnergyPeriodMetric = "energy_d";

    [DefaultValue(EmonCmsFeedEngine.PHPFina)]
    [Description("Default feed storage engine, for types that don't set their own. PHPFina = fixed-interval time series, PHPTimeSeries = variable interval, MySQL = MySQL storage (no phpfina files).")]
    public EmonCmsFeedEngine Engine { get; set; } = EmonCmsFeedEngine.PHPFina;

    [DefaultValue(10)]
    [Range(1, 86400, ErrorMessage = "Interval must be between 1 and 86400 seconds.")]
    [Description("Default sample interval in seconds for a fixed-interval feed, for types that don't set their own.")]
    public int IntervalSeconds { get; set; } = 10;

    /// <summary>The EmonCMS "tag" (group) feeds are filed under. Blank uses the input node name.</summary>
    [Description("The EmonCMS tag (group) new feeds are filed under. Blank uses the input node name.")]
    public string? Tag { get; set; }

    [DefaultValue("{device}_{source}")]
    [Description("Template for the storage-feed name, without the type — each type appends its own suffix. Use only stable placeholders ({device}, {source}, {number}) so the name never changes on a rename. Placeholders: {device}, {source}, {name}, {number}, {units}.")]
    [TemplateVariables("device", "source", "name", "number", "units")]
    public string StorageNameTemplate { get; set; } = "{device}_{source}";

    /// <summary>Optional friendly-named feeds that source their data from the stable storage feeds (#163).</summary>
    [Description("Optionally create friendly-named virtual feeds that source from the stable storage feeds — so dashboards get nice names while the underlying feeds stay idempotent.")]
    public EmonCmsVirtualFeedsConfig Virtual { get; set; } = new();
}

/// <summary>Per-measurement-type feed settings. Also accepts a bare type string (the v1 form) on load.</summary>
[System.Text.Json.Serialization.JsonConverter(typeof(EmonCmsFeedTypeConfigConverter))]
public class EmonCmsFeedTypeConfig
{
    [Description("The measurement type this applies to.")]
    [AllowedValues("realpower", "energy", "energy_d", "apparentpower", "current", "voltage", "frequency", "powerfactor")]
    public string Type { get; set; } = "realpower";

    [DefaultValue(true)]
    [Description("Build and maintain a feed for this type.")]
    public bool Enabled { get; set; } = true;

    [DefaultValue(EmonCmsCalculation.PreferLocal)]
    [Description("Who works this type out when both could.")]
    [RadioChoices]
    // Frequency is measured and nothing computes it, so the question does not arise there.
    [VisibleWhen(nameof(Type), "realpower", "apparentpower", "energy", "energy_d", "voltage", "current", "powerfactor")]
    public EmonCmsCalculation Calculation { get; set; } = EmonCmsCalculation.PreferLocal;

    [Description("Text placed before the feed name. Blank by default. Placeholders: {device}, {source}, {name}, {number}, {type}, {units}.")]
    [TemplateVariables("device", "source", "name", "number", "type", "units")]
    public string? Prefix { get; set; }

    [Description("Text placed after the feed name, which is where the type appears. Placeholders: {device}, {source}, {name}, {number}, {type}, {units}.")]
    [TemplateVariables("device", "source", "name", "number", "type", "units")]
    public string Suffix { get; set; } = "_realpower";

    [Description("The unit this feed is stored in.")]
    public string Units { get; set; } = "W";

    [Description("Feed storage engine for this type. Blank inherits Feeds.Engine. PHPFina = fixed-interval, PHPTimeSeries = variable, MySQL = MySQL storage.")]
    public EmonCmsFeedEngine? Engine { get; set; }

    [DefaultValue(10)]
    [Range(1, 86400, ErrorMessage = "Interval must be between 1 and 86400 seconds.")]
    [Description("Sample interval in seconds for this type's feed.")]
    public int IntervalSeconds { get; set; } = 10;

    /// <summary>A type with its shipped defaults: suffix, units and interval all follow from what it is.</summary>
    public static EmonCmsFeedTypeConfig For(string type) => new()
    {
        Type = type,
        Suffix = "_" + type,
        Units = UnitFor(type),
        IntervalSeconds = string.Equals(type, EmonCmsFeedsConfig.EnergyPeriodMetric, StringComparison.OrdinalIgnoreCase) ? 86400 : 10,
        Calculation = DefaultCalculation(type),
    };

    /// <summary>
    /// Who works a type out unless told otherwise. The daily total is EmonCMS's: it owns the day boundary,
    /// so a clock drifting here cannot push a reading into the wrong day. Everything else prefers the
    /// reading that arrived, and falls back to EmonCMS only where none does.
    /// </summary>
    public static EmonCmsCalculation DefaultCalculation(string type)
        => string.Equals(type, EmonCmsFeedsConfig.EnergyPeriodMetric, StringComparison.OrdinalIgnoreCase)
            ? EmonCmsCalculation.ForceEmonCms
            : EmonCmsCalculation.PreferLocal;

    /// <summary>The unit a measurement type is stored in unless it is told otherwise.</summary>
    public static string UnitFor(string type) => type.ToLowerInvariant() switch
    {
        "realpower" => "W",
        "apparentpower" => "VA",
        "energy" or "energy_d" => "kWh",
        "current" => "A",
        "voltage" => "V",
        "frequency" => "Hz",
        _ => "",
    };
}

/// <summary>Friendly virtual feeds that source from the stable storage feeds.</summary>
public class EmonCmsVirtualFeedsConfig
{
    [DefaultValue(false)]
    [Description("Create a friendly-named virtual feed for each storage feed, sourced from it (source_feed process).")]
    public bool Enabled { get; set; }

    [DefaultValue("{name} {type}")]
    [Description("Template for the friendly virtual-feed name. {name} is the source's display name, so these can change freely without touching the stable storage feeds. Placeholders: {device}, {source}, {name}, {number}, {type}, {units}.")]
    [TemplateVariables("device", "source", "name", "number", "type", "units")]
    public string NameTemplate { get; set; } = "{name} {type}";

    /// <summary>The EmonCMS tag (group) virtual feeds are filed under. Blank uses the main Feeds tag.</summary>
    [Description("The EmonCMS tag (group/node) virtual feeds are filed under — set this to keep the friendly virtual feeds separate from the storage feeds. Blank uses the main Feeds tag.")]
    public string? Tag { get; set; }
}
