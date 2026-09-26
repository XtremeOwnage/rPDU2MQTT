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
    /// <summary>
    /// Use the history backend as a last-resort live source: a node nothing currently reports takes the
    /// most recent value stored about it.
    ///
    /// <para>
    /// Off by default, and deliberately so. A value read back from storage is older than one from an
    /// ingest, and for a node whose publisher has genuinely stopped it turns "no data" — which is the
    /// truth — into a figure that looks current. Worth having when the thing measuring a node writes to
    /// EmonCMS or Prometheus directly and this bridge only reads; wrong the rest of the time.
    /// </para>
    /// </summary>
    [DefaultValue(false)]
    [Description("Let the history backend supply a value for any node nothing live is reporting. Off by default: a stored value is older than a live one, and for a node whose source has stopped it replaces an honest \"no data\" with a figure that looks current.")]
    public bool ValueFallback { get; set; }

    [DefaultValue(false)]
    [Description("Let the Flow and Energy pages show a past moment, read from Prometheus or EmonCMS.")]
    [FeatureToggle]
    public bool Enabled { get; set; }

    [DefaultValue("local")]
    [Description("Where past readings come from: 'local' (kept by the bridge itself, no other service needed), 'prometheus', 'emoncms' or 'homeassistant'.")]
    [AllowedValues("local", "prometheus", "emoncms", "homeassistant")]
    public string Provider { get; set; } = "local";

    /// <summary>
    /// Base URL of the Prometheus that scrapes this bridge — the server, not the exporter here.
    /// </summary>
    [Description("Prometheus base URL to query, e.g. http://prometheus:9090 . This is the server that scrapes this bridge, not the /metrics endpoint it exposes.")]
    [VisibleWhen(nameof(Provider), "prometheus")]
    public string? PrometheusUrl { get; set; }

    /// <summary>
    /// Recording is a destination, not a backend: the bridge keeps its own copy of every reading whatever
    /// the pages are reading from. Turning it off is what loses readings — a store that is only written
    /// while it is also the chosen backend has nothing in it on the day someone switches to it.
    /// </summary>
    [DefaultValue(true)]
    [Description("Keep a copy of every reading in the bridge's own store, whether or not it is the backend the pages read from. On by default: a store nothing wrote to is empty on the day you want it.")]
    [FeatureToggle]
    public bool LocalEnabled { get; set; } = true;

    [Description("Where the bridge keeps its own history: a directory of fixed-interval files, one per series. Left empty it uses the directory the deployment mounted for it (RPDU2MQTT_HISTORY_DIRECTORY), else one beside the program — which goes with the container when it restarts.")]
    [DefaultValue("")]
    public string LocalPath { get; set; } = "";

    [DefaultValue(7)]
    [Range(1, 3650)]
    [Description("How many days of readings are kept at the rate they arrive. Older ones are still there a minute at a time.")]
    public int LocalRawKeepDays { get; set; } = 7;

    [DefaultValue(90)]
    [Range(1, 3650)]
    [Description("How many days are kept a minute at a time.")]
    public int LocalMinuteKeepDays { get; set; } = 90;

    [DefaultValue(730)]
    [Range(1, 36500)]
    [Description("How many days are kept an hour at a time. Two years of hourly readings for two hundred series is about 3 MB.")]
    public int LocalHourKeepDays { get; set; } = 730;

    [DefaultValue(36500)]
    [Range(1, 36500)]
    [Description("How many days are kept a day at a time — the resolution a month or a year of history is drawn from. A century of them for two hundred series is about 60 MB, so there is little reason to drop any.")]
    public int LocalDayKeepDays { get; set; } = 36500;

    [DefaultValue(30)]
    [Range(1, 600)]
    [Description("How far either side of the requested moment to look for a sample, in seconds. A scrape or feed interval longer than this returns nothing rather than a value from a different time.")]
    public int ToleranceSeconds { get; set; } = 30;
}
