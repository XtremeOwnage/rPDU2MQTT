using System.ComponentModel;

namespace rPDU2MQTT.Models.Config;

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
}
