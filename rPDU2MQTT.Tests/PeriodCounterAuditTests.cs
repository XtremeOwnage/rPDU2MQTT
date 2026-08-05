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
