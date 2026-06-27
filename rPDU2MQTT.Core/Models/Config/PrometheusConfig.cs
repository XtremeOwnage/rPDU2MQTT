using System.ComponentModel;
using System.Text.Json.Serialization;
using YamlDotNet.Serialization;

namespace rPDU2MQTT.Models.Config;

/// <summary>
/// Configuration for Prometheus metrics. The scrape exporter and the Pushgateway push are independent
/// — enable either or both.
/// </summary>
public class PrometheusConfig
{
    [DefaultValue(false)]
    [Description("Expose a /metrics endpoint for Prometheus to scrape.")]
    public bool Exporter { get; set; }

    /// <summary>Port the /metrics endpoint listens on (Exporter).</summary>
    [DefaultValue(9184)]
    [Description("Port the /metrics endpoint listens on (Exporter).")]
    public int Port { get; set; } = 9184;

    /// <summary>
    /// Template for generated metric names. Placeholders: {type} (measurement type, honoring its
    /// Overrides.Measurements ID), {device}, {source}/{outlet}, {units}. The result is lower-cased
    /// and non-alphanumeric characters become underscores. device/source/units are also always
    /// emitted as labels.
    /// </summary>
    [DefaultValue("rpdu2mqtt_{type}")]
    [Description("Template for Prometheus metric names. Placeholders: {type}, {device}, {source} (a.k.a. {outlet}), {units}. e.g. 'rpdu2mqtt_{type}' -> rpdu2mqtt_realpower; 'pdu_{device}_{type}' -> pdu_rack_pdu_1_realpower. (device/source/units are also emitted as labels.)")]
    [TemplateVariables("type", "device", "source", "units")]
    public string MetricNameTemplate { get; set; } = "rpdu2mqtt_{type}";

    [Description("Push metrics to a Prometheus Pushgateway.")]
    public PrometheusPushgatewayConfig Pushgateway { get; set; } = new();

    /// <summary>
    /// Back-compat: the old single "Enabled" flag meant "run the exporter". Applied during config load.
    /// Hidden from the GUI/JSON.
    /// </summary>
    [JsonIgnore]
    [YamlMember(Alias = "Enabled", DefaultValuesHandling = DefaultValuesHandling.OmitNull)]
    public bool? EnabledAlias { get; set; }
}

/// <summary>Settings for pushing metrics to a Prometheus Pushgateway.</summary>
public class PrometheusPushgatewayConfig
{
    [DefaultValue(false)]
    [Description("Push metrics to a Pushgateway.")]
    public bool Enabled { get; set; }

    /// <summary>Pushgateway endpoint, e.g. "http://pushgateway:9091/metrics".</summary>
    [Description("Pushgateway endpoint, e.g. http://pushgateway:9091/metrics.")]
    public string? Url { get; set; }

    /// <summary>The "job" label applied to pushed metrics.</summary>
    [DefaultValue("rpdu2mqtt")]
    [Description("The 'job' label applied to pushed metrics.")]
    public string Job { get; set; } = "rpdu2mqtt";

    /// <summary>How often to push, in seconds. Falls back to the PDU poll interval when 0.</summary>
    [DefaultValue(0)]
    [Description("How often to push, in seconds. Falls back to the PDU poll interval when 0.")]
    public int IntervalSeconds { get; set; }
}
