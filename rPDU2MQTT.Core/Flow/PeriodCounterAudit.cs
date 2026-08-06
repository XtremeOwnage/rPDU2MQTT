namespace rPDU2MQTT.Core.Flow;

/// <summary>
/// Checks a source that <em>claims</em> to be a daily counter against what it actually does.
///
/// <para>
/// Declaring <c>Accumulation: period</c> means "the device zeroes this every day, so the reading already
/// <b>is</b> today's total" — and the bridge then publishes that number straight out as the day's energy,
/// with no arithmetic in between. There is nothing wrong with that shortcut except that nothing was
/// checking the claim. Point it at a cumulative counter by mistake and the lifetime total is displayed,
/// verbatim and with total confidence, as "today".
/// </para>
/// <para>
/// Seen live: a PV source wired to Solar Assistant's <c>total/pv_energy</c> read 129.9 kWh at 00:20 on a
/// system that makes about 70 kWh on its best day — every sibling source on the same install was declared
/// <c>lifetime</c> and was correct. The daily accumulator had the right answer stored the whole time (zero,
/// because the sun was down); the raw reading simply overrode it.
/// </para>
/// <para>
/// The test is the definition: a counter that resets each period must be <b>lower</b> at the start of the
/// next period than it was at the end of the last one. If it is not, then whatever that number is, it is
/// not today's — either it is cumulative, or the device has not reported since the day rolled and the value
/// is yesterday's. Both cases mean the same thing for what may be displayed, so both are treated the same.
/// </para>
/// </summary>
public static class PeriodCounterAudit
{
    /// <summary>What one period-declared source has done so far.</summary>
    /// <param name="PeriodKey">The period the last reading fell in.</param>
    /// <param name="HighWater">The largest value seen in that period — what a reset has to fall below.</param>
    /// <param name="Contradicted">The source failed to reset across a boundary, so its reading is not "today".</param>
    public sealed record State(string PeriodKey, double HighWater, bool Contradicted);

    /// <summary>
    /// A counter sitting at zero says nothing about whether it resets, so a period that ended at (or near)
    /// zero is never used to judge the next one. Without this, a night with no production would convict a
    /// perfectly honest daily counter of being cumulative.
    /// </summary>
    private const double Meaningful = 0.05;

    /// <summary>
    /// Fold one reading in, and say whether the source may still be treated as a daily total.
    /// </summary>
    /// <remarks>
    /// The verdict can clear itself. A source that starts reporting properly — or a config that gets
    /// corrected — produces a genuine reset at the next boundary and is trusted again from that moment,
    /// with no restart and nothing to acknowledge.
    /// </remarks>
    public static State Observe(State? prior, double value, string periodKey)
    {
        if (prior is null || !string.Equals(prior.PeriodKey, periodKey, StringComparison.Ordinal))
        {
            // First sight of this source, or the first reading of a new period — the moment of truth.
            var judgeable = prior is not null && prior.HighWater > Meaningful;
            var didNotReset = judgeable && value >= prior!.HighWater - Meaningful;
            return new State(periodKey, value, didNotReset);
        }

        // Same period: track the high-water mark. Max rather than last, because a counter that dips and
        // recovers mid-period (a device restart, a re-publish) must still have to fall below the real peak
        // to count as having reset.
        return prior with { HighWater = Math.Max(prior.HighWater, value) };
    }

    /// <summary>
    /// Whether this source makes the claim at all. Only an energy source declared <c>period</c> does — a
    /// lifetime counter is supposed to climb across midnight, and the daily figure is derived from it.
    /// </summary>
    public static bool Applies(Models.Config.EnergyFlowSource src) =>
        FlowMetricKey.IsPeriod(src.Accumulation)
        && string.Equals(src.Metric, "energy", StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// Fold a reading in and say whether it may be published as today's total, warning once per change of
    /// verdict. Shared by every ingest: a rule that only one transport applies is a rule with a hole in it,
    /// and the hole is wherever the user happened to wire the counter.
    /// </summary>
    /// <param name="audit">Per-source state, keyed by <paramref name="nodeId"/>/<paramref name="source"/>/direction.</param>
    /// <param name="source">How to name this binding to whoever has to fix it — a topic, or a register.</param>
    public static bool Allow(
        IDictionary<string, State> audit, string periodKey,
        string nodeId, string source, string? direction, double value, Action<string>? warn)
    {
        var key = $"{nodeId}|{source}|{direction}";
        audit.TryGetValue(key, out var prior);
        var next = Observe(prior, value, periodKey);
        audit[key] = next;

        // Once per transition, not per sample: a message on every reading buries the one that matters.
        if (next.Contradicted && prior?.Contradicted != true)
            warn?.Invoke(Explain(nodeId, source, value, periodKey));
        else if (!next.Contradicted && prior?.Contradicted == true)
            warn?.Invoke($"Energy-flow: '{source}' on node '{nodeId}' reset properly for {periodKey}; it is being "
                       + "treated as a daily counter again.");

        return !next.Contradicted;
    }

    /// <summary>
    /// How to explain a contradicted source to whoever has to fix it — naming the source, the reading, and
    /// what to change. A warning nobody can act on is only noise.
    /// </summary>
    public static string Explain(string nodeId, string source, double value, string periodKey) =>
        $"Energy-flow: '{source}' on node '{nodeId}' is configured as a daily (period) counter, but it did not "
      + $"reset when the day rolled over to {periodKey} — it still reads {value:0.###}. That is not today's "
      + "total, so it is being withheld rather than displayed as one. Either the counter is cumulative (set "
      + "its Accumulation to 'lifetime' and the daily figure will be derived from it), or the device has not "
      + "reported since the rollover.";
}
