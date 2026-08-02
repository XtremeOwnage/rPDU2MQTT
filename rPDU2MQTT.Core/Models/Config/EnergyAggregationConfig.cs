using System.ComponentModel;
using System.ComponentModel.DataAnnotations;

namespace rPDU2MQTT.Models.Config;

/// <summary>
/// Marks a string field whose choices are the time zones <b>this host</b> can actually resolve, filled in at
/// schema-generation time rather than declared here.
///
/// <para>
/// [AllowedValues] can't express it: the list is ~600 entries, it varies by image (a container without tzdata
/// has almost none), and a hard-coded set would offer zones that then fail to resolve at runtime. Reusing the
/// existing EnumValues plumbing means the GUI renders a dropdown with no frontend changes at all.
/// </para>
/// </summary>
[AttributeUsage(AttributeTargets.Property)]
public sealed class TimeZoneChoicesAttribute : Attribute;

/// <summary>
/// Deriving energy (kWh) from power readings.
///
/// <para>
/// Plenty of sources report instantaneous power and no cumulative energy — a CT clamp, an inverter's
/// live wattage. Integrating that over time gives the kWh the Energy Dashboard and EmonCMS feeds want,
/// without a second meter.
/// </para>
/// <para>
/// A derived total is only ever used where nothing measures energy directly: a real energy binding on a
/// node always wins. Off by default, because a derived figure is an estimate and should be an opt-in.
/// </para>
/// </summary>
public class EnergyAggregationConfig
{
    [DefaultValue(false)]
    [Description("Derive energy (kWh) by integrating each node's power over time. A real energy source on a node always takes precedence.")]
    public bool Enabled { get; set; }

    [DefaultValue(10)]
    [Description("How often to sample power, in seconds. Shorter samples track a spiky load more closely.")]
    public int SampleIntervalSeconds { get; set; } = 10;

    /// <summary>
    /// The longest gap between two samples that is still integrated. Beyond it the power in between is
    /// genuinely unknown — a dead publisher, a restart, a partition — and none of that time is counted
    /// rather than assuming the last reading held.
    /// </summary>
    [DefaultValue(60)]
    [Description("Longest gap between samples that still counts, in seconds. A longer gap is recorded as unmeasured rather than guessed.")]
    public int MaxGapSeconds { get; set; } = 60;

    /// <summary>
    /// Keep a per-day total for every node and outlet, alongside the lifetime one.
    ///
    /// <para>
    /// On by default, and not an estimate: for an outlet it is the rise of the PDU's own counter since local
    /// midnight, which is measured, not inferred. It exists because lifetime counters cannot be compared to
    /// each other — a PDU's has been running since the unit was commissioned, a derived node's since its
    /// binding was configured — so adding them up produced a flow diagram that contradicted itself. Daily
    /// totals all start at the same instant, so they legitimately sum.
    /// </para>
    /// </summary>
    [DefaultValue(true)]
    [Description("Track a daily energy total per node and outlet, so the flow diagram compares figures that all start at the same moment. Lifetime totals are unaffected.")]
    public bool TrackPeriods { get; set; } = true;

    /// <summary>
    /// The zone whose midnight ends the day. Blank means the host's — which under Kubernetes is UTC unless
    /// TZ is set, and a day that rolls at UTC midnight is not the day anyone is looking at.
    /// </summary>
    [TimeZoneChoices]
    [Description("IANA time zone the daily total rolls over in, e.g. \"America/Chicago\". Blank uses the host's local time zone — which in a container is usually UTC.")]
    public string? PeriodTimeZone { get; set; }

    /// <summary>
    /// The hour the day starts, in <see cref="PeriodTimeZone"/>. Midnight for almost everyone; a utility
    /// whose billing day runs 06:00 to 06:00 — or anyone who would rather the chart didn't reset while they
    /// were looking at it — can move it.
    /// </summary>
    [DefaultValue(0)]
    [Range(0, 23)]
    [Description("Hour of the day the daily total rolls over, in the period time zone. 0 = midnight.")]
    public int PeriodStartHour { get; set; }
}
