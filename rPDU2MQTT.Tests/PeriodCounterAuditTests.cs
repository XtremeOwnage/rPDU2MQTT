using rPDU2MQTT.Core.Flow;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// A source declared <c>Accumulation: period</c> is published as the day's energy total with no arithmetic
/// in between, so the claim has to be checked rather than trusted.
///
/// <para>
/// The failure these pin, seen live: a PV source wired to Solar Assistant's cumulative
/// <c>total/pv_energy</c> but declared as a daily counter read <b>129.9 kWh at 00:20</b>, on a system whose
/// best day is about 70 kWh, with the sun down and every MPPT reporting zero. The daily accumulator had the
/// right answer stored the whole time; the raw reading simply overrode it, and nothing anywhere compared
/// the two.
/// </para>
/// </summary>
public class PeriodCounterAuditTests
{
    private static PeriodCounterAudit.State Feed(PeriodCounterAudit.State? state, string day, params double[] values)
    {
        foreach (var v in values) state = PeriodCounterAudit.Observe(state, v, day);
        return state!;
    }

    [Fact]
    public void ACumulativeCounter_IsCaughtAtTheFirstRollover()
    {
        // Yesterday it climbed to 129.9. Today it opens at 129.9 and keeps climbing — the defining
        // behaviour of a counter that does not reset.
        var state = Feed(null, "2026-08-04", 60.0, 95.5, 129.9);
        Assert.False(state.Contradicted);

        state = PeriodCounterAudit.Observe(state, 129.9, "2026-08-05");
        Assert.True(state.Contradicted);
    }

    [Fact]
    public void AGenuineDailyCounter_IsLeftAlone()
    {
        var state = Feed(null, "2026-08-04", 12.0, 48.0, 69.4);
        state = PeriodCounterAudit.Observe(state, 0.0, "2026-08-05");
        Assert.False(state.Contradicted);

        // And it keeps being trusted as it climbs through the new day.
        state = Feed(state, "2026-08-05", 0.3, 11.2);
        Assert.False(state.Contradicted);
    }

    [Fact]
    public void ANightWithNoProduction_ConvictsNobody()
    {
        // The false positive that would matter most: a day that legitimately ended at zero says nothing
        // about whether the counter resets, so the next day must not be judged on it. Without this, every
        // honest daily counter on a cloudy winter system would be withheld.
        var state = Feed(null, "2026-08-04", 0.0, 0.0);
        state = PeriodCounterAudit.Observe(state, 0.0, "2026-08-05");
        Assert.False(state.Contradicted);
    }

    [Fact]
    public void ADeviceThatStoppedReportingBeforeTheRollover_IsAlsoWithheld()
    {
        // Same evidence, different cause: the value is unchanged across the boundary because nothing new
        // arrived. It is yesterday's total either way, and displaying it as today's is equally wrong — so
        // there is deliberately no attempt to tell the two apart.
        var state = Feed(null, "2026-08-04", 70.0);
        state = PeriodCounterAudit.Observe(state, 70.0, "2026-08-05");
        Assert.True(state.Contradicted);
    }

    [Fact]
    public void TheVerdictClearsItself_WhenTheSourceStartsBehaving()
    {
        // Correcting the config (or the device) must not need a restart or an acknowledgement — the next
        // genuine reset is the evidence, and it is accepted the moment it arrives.
        var state = Feed(null, "2026-08-04", 129.9);
        state = PeriodCounterAudit.Observe(state, 129.9, "2026-08-05");
        Assert.True(state.Contradicted);

        state = Feed(state, "2026-08-05", 140.0);
        state = PeriodCounterAudit.Observe(state, 0.0, "2026-08-06");
        Assert.False(state.Contradicted);
    }

    [Fact]
    public void AMidPeriodDip_DoesNotCountAsAReset()
    {
        // A device restart or a re-publish can make the counter fall inside a period. The high-water mark
        // is what a reset has to beat, so the dip alone doesn't make a cumulative source look honest.
        var state = Feed(null, "2026-08-04", 100.0, 3.0, 120.0);
        Assert.Equal(120.0, state.HighWater);

        state = PeriodCounterAudit.Observe(state, 120.0, "2026-08-05");
        Assert.True(state.Contradicted);
    }

    [Fact]
    public void TheFirstReadingEverIsTrusted()
    {
        // Nothing has been observed across a boundary yet, so there is no evidence either way. Withholding
        // on suspicion would blank out every correctly configured install for its first day.
        var state = PeriodCounterAudit.Observe(null, 129.9, "2026-08-05");
        Assert.False(state.Contradicted);
    }

    [Fact]
    public void Allow_WithholdsAfterTheMissedReset_AndWarnsOnlyOnTheTransition()
    {
        // The shared entry point both ingests call. Warning on every sample would bury the one that
        // matters under a poll-rate stream of identical lines.
        var audit = new Dictionary<string, PeriodCounterAudit.State>();
        var warnings = new List<string>();
        bool Allow(double v, string day) =>
            PeriodCounterAudit.Allow(audit, day, "solar", "register 40 on inv1", "out", v, warnings.Add);

        Assert.True(Allow(129.9, "2026-08-04"));
        Assert.Empty(warnings);

        Assert.False(Allow(130.4, "2026-08-05"));
        Assert.False(Allow(131.0, "2026-08-05"));
        Assert.False(Allow(131.6, "2026-08-05"));
        Assert.Single(warnings);
        Assert.Contains("register 40 on inv1", warnings[0]);
    }

    [Fact]
    public void Allow_SaysSoWhenASourceStartsBehavingAgain()
    {
        var audit = new Dictionary<string, PeriodCounterAudit.State>();
        var warnings = new List<string>();
        bool Allow(double v, string day) =>
            PeriodCounterAudit.Allow(audit, day, "solar", "sa/pv_energy", "out", v, warnings.Add);

        Allow(129.9, "2026-08-04");
        Assert.False(Allow(130.4, "2026-08-05"));
        Allow(140.0, "2026-08-05");
        Assert.True(Allow(0.0, "2026-08-06"));

        Assert.Equal(2, warnings.Count);
        Assert.Contains("did not reset", warnings[0]);
        Assert.Contains("reset properly", warnings[1]);
    }

    [Fact]
    public void Allow_JudgesEachBindingSeparately()
    {
        // A node's in and out legs are different quantities on the same register, and two nodes can be fed
        // by one topic. Sharing a verdict between them would convict a counter for its neighbour's sins.
        var audit = new Dictionary<string, PeriodCounterAudit.State>();
        bool Allow(string node, string src, string dir, double v, string day) =>
            PeriodCounterAudit.Allow(audit, day, node, src, dir, v, null);

        Allow("grid", "sa/energy", "out", 50.0, "2026-08-04");
        Allow("grid", "sa/energy", "in", 20.0, "2026-08-04");
        Allow("solar", "sa/energy", "out", 80.0, "2026-08-04");

        // Only the out leg fails to reset.
        Assert.False(Allow("grid", "sa/energy", "out", 51.0, "2026-08-05"));
        Assert.True(Allow("grid", "sa/energy", "in", 0.0, "2026-08-05"));
        Assert.True(Allow("solar", "sa/energy", "out", 0.4, "2026-08-05"));
    }

    [Theory]
    [InlineData("period", "energy", true)]
    [InlineData("lifetime", "energy", false)]     // supposed to climb; the daily figure is derived from it
    [InlineData("period", "realpower", false)]    // instantaneous — nothing accumulates, nothing resets
    [InlineData(null, "energy", false)]
    public void Applies_OnlyToAnEnergySourceDeclaredAsADailyCounter(string? accumulation, string metric, bool expected)
        => Assert.Equal(expected, PeriodCounterAudit.Applies(
            new rPDU2MQTT.Models.Config.EnergyFlowSource { Metric = metric, Accumulation = accumulation! }));

    [Fact]
    public void WithheldIn_ReportsOnlyTheContradictedBindings_WithTheirReason()
    {
        // What the GUI reads to explain a missing number. A withheld value whose reason lives only in a log
        // line leaves the node reading "no data", indistinguishable from a binding nobody ever configured.
        var audit = new Dictionary<string, PeriodCounterAudit.State>();
        PeriodCounterAudit.Allow(audit, "2026-08-04", "solar", "sa/pv_energy", "out", 129.9, null);
        PeriodCounterAudit.Allow(audit, "2026-08-04", "grid", "sa/grid_energy", "out", 50.0, null);
        PeriodCounterAudit.Allow(audit, "2026-08-05", "solar", "sa/pv_energy", "out", 130.4, null);   // no reset
        PeriodCounterAudit.Allow(audit, "2026-08-05", "grid", "sa/grid_energy", "out", 0.0, null);    // reset

        var withheld = PeriodCounterAudit.WithheldIn(audit);
        var one = Assert.Single(withheld);
        Assert.Equal("solar", one.Node);
        Assert.Equal("sa/pv_energy", one.Source);
        Assert.Contains("did not reset", one.Reason);
    }

    [Fact]
    public void WithheldIn_KeepsASourceNameThatContainsASeparator()
    {
        // MQTT topics are slash-delimited, but nothing stops a register label or a future source name from
        // carrying the '|' the key is built with. Splitting on the wrong one silently renames the binding
        // in the very message meant to help someone find it.
        var audit = new Dictionary<string, PeriodCounterAudit.State>();
        PeriodCounterAudit.Allow(audit, "2026-08-04", "solar", "odd|name", "out", 129.9, null);
        PeriodCounterAudit.Allow(audit, "2026-08-05", "solar", "odd|name", "out", 130.4, null);

        Assert.Equal("odd|name", Assert.Single(PeriodCounterAudit.WithheldIn(audit)).Source);
    }

    [Fact]
    public void TheExplanationNamesTheSourceAndTheFix()
    {
        // A warning nobody can act on is noise. This one has to identify which binding, and say what to change.
        var msg = PeriodCounterAudit.Explain("eg4-flexboss21-solar", "solar_assistant/total/pv_energy/state", 129.9, "2026-08-05");
        Assert.Contains("eg4-flexboss21-solar", msg);
        Assert.Contains("solar_assistant/total/pv_energy/state", msg);
        Assert.Contains("129.9", msg);
        Assert.Contains("lifetime", msg);
    }
}
