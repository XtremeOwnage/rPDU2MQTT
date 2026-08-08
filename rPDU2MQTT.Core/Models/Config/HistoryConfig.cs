using System.ComponentModel;
using System.ComponentModel.DataAnnotations;

namespace rPDU2MQTT.Models.Config;

/// <summary>
/// Where the Flow and Energy pages read past values from (#372).
///
/// <para>
/// The bridge keeps no history of its own — it holds the latest reading and the running totals. Anything
/// older already lives in whatever the readings were exported to, so history is a read against that rather
/// than a second copy here.
/// </para>
/// </summary>
public class HistoryConfig
{
    [DefaultValue(false)]
    [Description("Let the Flow and Energy pages show a past moment, read from Prometheus or EmonCMS.")]
    [FeatureToggle]
    public bool Enabled { get; set; }

    [DefaultValue("prometheus")]
    [Description("Which backend to read from: 'prometheus' or 'emoncms'.")]
    [AllowedValues("prometheus", "emoncms")]
    public string Provider { get; set; } = "prometheus";

    /// <summary>
    /// Base URL of the Prometheus that scrapes this bridge — the server, not the exporter here.
    /// </summary>
    [Description("Prometheus base URL to query, e.g. http://prometheus:9090 . This is the server that scrapes this bridge, not the /metrics endpoint it exposes.")]
    public string? PrometheusUrl { get; set; }

    [DefaultValue(30)]
    [Range(1, 600)]
    [Description("How far either side of the requested moment to look for a sample, in seconds. A scrape or feed interval longer than this returns nothing rather than a value from a different time.")]
    public int ToleranceSeconds { get; set; } = 30;
}
