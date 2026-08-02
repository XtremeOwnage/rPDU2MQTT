namespace rPDU2MQTT.Core.Flow;

/// <summary>What has been accumulated for one node so far.</summary>
/// <param name="KWh">
/// Our own cumulative total for this node. Monotonic — it only ever goes up. Advanced either by integrating
/// measured power (<see cref="EnergyIntegrator.Accumulate"/>) or by folding in the rise of a device's own
/// counter (<see cref="EnergyIntegrator.Observe"/>); both produce the same quantity, which is what lets a
/// derived node and a metered outlet be compared at all.
/// </param>
/// <param name="LastSampleUtc">When the last usable sample was taken; default when there is none yet.</param>
/// <param name="LastPowerW">The power at that sample, in watts.</param>
/// <param name="UnmeasuredSeconds">
/// Total time deliberately NOT counted, because power was unknown across it. Reported so the figure can be
/// judged rather than silently trusted.
/// </param>
/// <param name="PeriodKey">
/// The period (a local date, "yyyy-MM-dd") that <see cref="PeriodStartKWh"/> was captured at the start of.
/// Null until the first sample, and on state carried over from a build that predates period tracking.
/// </param>
/// <param name="PeriodStartKWh"><see cref="KWh"/> as it read when the current period began.</param>
/// <param name="LastCounterKWh">
/// The last raw reading of a device-maintained counter, for <see cref="EnergyIntegrator.Observe"/> to take
/// a delta against. Null for a node whose total we integrate ourselves.
/// </param>
public readonly record struct EnergyState(
    double KWh,
    DateTime LastSampleUtc,
    double LastPowerW,
    double UnmeasuredSeconds,
    string? PeriodKey = null,
    double PeriodStartKWh = 0,
    double? LastCounterKWh = null)
{
    public static readonly EnergyState Empty = new(0, default, 0, 0);

    /// <summary>
    /// Energy accrued since the current period began — the figure that is comparable across nodes, because
    /// every node's period starts at the same instant regardless of when its counter was first seen.
    /// </summary>
    public double PeriodKWh => Math.Max(0, KWh - PeriodStartKWh);
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
/// It also keeps each node's <b>period</b> total (energy since local midnight). That exists because a
/// cumulative counter is only comparable to another cumulative counter that started at the same moment,
/// and ours never do: a PDU's firmware counter has been running since the unit was commissioned, a derived
/// node's since its binding was first configured. Summing across that boundary produced a diagram where a
/// 740 kWh inverter fed an 8,358 kWh panel. A period total re-bases every node at the same instant, so the
/// figures can legitimately be added up — and it self-heals, since a node bound today is only incomparable
/// until the next rollover rather than forever.
/// </para>
/// <para>
/// Pure and transport-free so the arithmetic is testable without a broker, a clock or a store.
/// </para>
/// </summary>
public static class EnergyIntegrator
{
    /// <summary>
    /// Start a new period if <paramref name="periodKey"/> has moved on, baselining it at whatever the
    /// cumulative total reads right now.
    ///
    /// <para>
    /// Applied before the sample is folded in, so energy accrued across the boundary lands wholly in the new
    /// period. That misplaces at most one sample interval's worth (seconds), and the alternative — splitting
    /// the interval at the boundary — would claim to know how the power was distributed within it.
    /// </para>
    /// <para>
    /// A null key means period tracking is off; the state is returned untouched so nothing is baselined and
    /// <see cref="EnergyState.PeriodKWh"/> simply tracks the lifetime total.
    /// </para>
    /// </summary>
    public static EnergyState Roll(EnergyState prev, string? periodKey)
        => periodKey is null || string.Equals(prev.PeriodKey, periodKey, StringComparison.Ordinal)
            ? prev
            : prev with { PeriodKey = periodKey, PeriodStartKWh = prev.KWh };

    /// <summary>
    /// Fold one power reading into the running total. <paramref name="maxGap"/> is how far apart two
    /// samples may be and still be integrated; beyond it the span is recorded as unmeasured.
    /// </summary>
    public static EnergyState Accumulate(EnergyState prev, double powerW, DateTime nowUtc, TimeSpan maxGap, string? periodKey = null)
    {
        prev = Roll(prev, periodKey);

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

    /// <summary>
    /// Fold in a reading of a counter someone else maintains — a PDU outlet's lifetime kWh from firmware.
    ///
    /// <para>
    /// We take its <em>rise</em> rather than its face value, because the face value is measured from an epoch
    /// we don't know and can't reconcile against anything else. The rise is a real measurement over a real
    /// interval, and accumulating it gives a total on the same footing as an integrated one.
    /// </para>
    /// <para>
    /// A counter reading lower than last time was reset — a reboot, a firmware clear, an outlet re-provisioned.
    /// What it reads now is what has accrued since that reset, so it counts as the delta; treating it as
    /// <c>now - last</c> would go negative and drag the total backwards, which is the one thing a cumulative
    /// counter must never do. Energy from before the reset stays counted, because it genuinely happened.
    /// </para>
    /// <para>
    /// The first ever reading advances nothing: there is no interval behind it, so it only establishes the
    /// mark that the next reading is measured against.
    /// </para>
    /// </summary>
    public static EnergyState Observe(EnergyState prev, double counterKWh, DateTime nowUtc, string? periodKey = null)
    {
        // A negative counter is not a reading of anything; ignore it rather than let it define a baseline.
        if (double.IsNaN(counterKWh) || double.IsInfinity(counterKWh) || counterKWh < 0)
            return prev;

        var state = Roll(prev, periodKey);

        if (prev.LastCounterKWh is not { } last)
            return state with { LastCounterKWh = counterKWh, LastSampleUtc = nowUtc };

        var delta = counterKWh >= last ? counterKWh - last : counterKWh;

        return state with
        {
            KWh = state.KWh + delta,
            LastCounterKWh = counterKWh,
            LastSampleUtc = nowUtc,
        };
    }
}
