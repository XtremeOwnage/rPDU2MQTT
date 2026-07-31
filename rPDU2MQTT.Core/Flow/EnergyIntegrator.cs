namespace rPDU2MQTT.Core.Flow;

/// <summary>What has been accumulated for one node so far.</summary>
/// <param name="KWh">Energy counted from measured power. Monotonic — it only ever goes up.</param>
/// <param name="LastSampleUtc">When the last usable sample was taken; default when there is none yet.</param>
/// <param name="LastPowerW">The power at that sample, in watts.</param>
/// <param name="UnmeasuredSeconds">
/// Total time deliberately NOT counted, because power was unknown across it. Reported so the figure can be
/// judged rather than silently trusted.
/// </param>
public readonly record struct EnergyState(double KWh, DateTime LastSampleUtc, double LastPowerW, double UnmeasuredSeconds)
{
    public static readonly EnergyState Empty = new(0, default, 0, 0);
}

/// <summary>
/// Turns a series of power readings into accumulated energy (#ToDo: "aggregate energy data using the
/// collected power data").
///
/// <para>
/// The whole difficulty is gaps. Between two samples we know the power at each end and nothing in
/// between, so the integral is only trustworthy while the samples are close together. Across a long gap —
/// a dead publisher, a restart, a network partition — the honest answer is that the energy is
/// <b>unknown</b>, and this counts none of it rather than assuming the last value held. That undercounts,
/// and undercounting is visible in <see cref="EnergyState.UnmeasuredSeconds"/>; assuming would invent a
/// number, which is the one thing this project refuses to do.
/// </para>
/// <para>
/// Pure and transport-free so the arithmetic is testable without a broker, a clock or a store.
/// </para>
/// </summary>
public static class EnergyIntegrator
{
    /// <summary>
    /// Fold one power reading into the running total. <paramref name="maxGap"/> is how far apart two
    /// samples may be and still be integrated; beyond it the span is recorded as unmeasured.
    /// </summary>
    public static EnergyState Accumulate(EnergyState prev, double powerW, DateTime nowUtc, TimeSpan maxGap)
    {
        // First ever sample: nothing to integrate over, just remember where we started.
        if (prev.LastSampleUtc == default)
            return prev with { LastSampleUtc = nowUtc, LastPowerW = powerW };

        var seconds = (nowUtc - prev.LastSampleUtc).TotalSeconds;

        // Time not moving forward (a duplicate sample, or a clock stepping backwards) contributes nothing.
        // Accepting a negative span would subtract from a counter that must only ever rise.
        if (seconds <= 0)
            return prev with { LastPowerW = powerW };

        if (seconds > maxGap.TotalSeconds)
            return prev with
            {
                LastSampleUtc = nowUtc,
                LastPowerW = powerW,
                UnmeasuredSeconds = prev.UnmeasuredSeconds + seconds,
            };

        // Trapezoidal: power is assumed to move linearly between two nearby samples, which is a far better
        // fit for a real load than holding the previous value flat until it jumps.
        var averageW = (prev.LastPowerW + powerW) / 2;
        var kWh = averageW * seconds / 3_600_000;

        return prev with
        {
            KWh = prev.KWh + kWh,
            LastSampleUtc = nowUtc,
            LastPowerW = powerW,
        };
    }
}
