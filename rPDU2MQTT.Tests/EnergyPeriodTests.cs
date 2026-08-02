using rPDU2MQTT.Core.Flow;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// The daily total, and the thing it exists to fix: cumulative counters started at different times cannot be
/// compared, so a flow diagram built from them contradicts its own arithmetic.
/// </summary>
public class EnergyPeriodTests
{
    private static readonly TimeSpan MaxGap = TimeSpan.FromMinutes(2);
    // Fixed offset, so the test says the same thing on a machine in any zone and through any DST change.
    private static readonly TimeZoneInfo Zone = TimeZoneInfo.CreateCustomTimeZone("t", TimeSpan.FromHours(-6), "t", "t");

    private static DateTime Utc(int day, int hour) => new(2026, 8, day, hour, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void ThePeriodKey_IsTheLocalDay_NotTheUtcOne()
    {
        // 03:00 UTC on the 2nd is still the evening of the 1st at UTC-6. A day that rolls at UTC midnight is
        // not the day the operator — or their utility — is looking at.
        Assert.Equal("2026-08-01", EnergyPeriod.KeyFor(Utc(2, 3), Zone));
        Assert.Equal("2026-08-02", EnergyPeriod.KeyFor(Utc(2, 7), Zone));
    }

    [Fact]
    public void ARollover_RebasesTheDailyTotal_AndLeavesTheLifetimeOneAlone()
    {
        var s = new EnergyState(40, default, 0, 0, "2026-08-01", 30);
        Assert.Equal(10, s.PeriodKWh);

        var rolled = EnergyIntegrator.Roll(s, "2026-08-02");

        Assert.Equal(40, rolled.KWh);          // lifetime is untouched — HA's history depends on it
        Assert.Equal(0, rolled.PeriodKWh);     // the new day starts at zero
        Assert.Equal("2026-08-02", rolled.PeriodKey);
    }

    [Fact]
    public void WithoutAPeriodKey_NothingIsRebased()
    {
        // Period tracking off: Roll must be inert rather than silently baselining at an arbitrary moment.
        var s = new EnergyState(40, default, 0, 0, "2026-08-01", 30);
        Assert.Equal(s, EnergyIntegrator.Roll(s, null));
    }

    [Fact]
    public void ObservingADeviceCounter_CountsItsRise_NotItsFaceValue()
    {
        // A PDU that has been counting since it was commissioned arrives reading 7,371 kWh. That figure is
        // measured from an epoch we know nothing about, so it must contribute nothing on sight — only what
        // it goes on to rise by is on the same footing as everything else in the diagram.
        var s = EnergyIntegrator.Observe(EnergyState.Empty, 7371.006, Utc(1, 8), "2026-08-01");
        Assert.Equal(0, s.KWh);
        Assert.Equal(0, s.PeriodKWh);

        s = EnergyIntegrator.Observe(s, 7373.506, Utc(1, 12), "2026-08-01");
        Assert.Equal(2.5, s.KWh, 6);
        Assert.Equal(2.5, s.PeriodKWh, 6);
    }

    [Fact]
    public void AStrayLowReading_IsIgnored_AndTheNextRealOneDoesNotBookTheWholeCounter()
    {
        // The bug that made a live system report 817 kWh of energy "today" on a rig that generates ~27.
        // A publisher restarting emitted one bogus low value; that was taken as a device reset and became the
        // new mark, so the very next ordinary reading measured against it booked the counter's entire
        // lifetime as today's energy. The drop was handled — the recovery was what destroyed the figure.
        var s = EnergyIntegrator.Observe(EnergyState.Empty, 750.0, Utc(1, 8), "2026-08-01");
        s = EnergyIntegrator.Observe(s, 751.5, Utc(1, 9), "2026-08-01");
        Assert.Equal(1.5, s.KWh, 6);

        s = EnergyIntegrator.Observe(s, 0, Utc(1, 10), "2026-08-01");     // the stray
        Assert.Equal(1.5, s.KWh, 6);                                      // counts nothing yet
        Assert.Equal(751.5, s.LastCounterKWh!.Value, 6);                  // and the mark does NOT move

        s = EnergyIntegrator.Observe(s, 791.9, Utc(1, 11), "2026-08-01"); // back to normal
        Assert.Equal(41.9, s.KWh, 6);                                     // 791.9 - 751.5, not 791.9
        Assert.Null(s.PendingResetKWh);
    }

    [Fact]
    public void ACounterThatStaysLow_WasGenuinelyReset_AndAdoptsTheNewBaseWithoutInventingEnergy()
    {
        // A real reset does not go away: the counter keeps reading low and climbing from its new base. Two
        // consecutive lows confirm it. Nothing is counted across the discontinuity — what the device accrued
        // between resetting and being seen again is genuinely unobserved, and guessing is what caused the bug
        // above. Energy from before the reset stays counted, because it genuinely happened.
        var s = EnergyIntegrator.Observe(EnergyState.Empty, 100, Utc(1, 8), "2026-08-01");
        s = EnergyIntegrator.Observe(s, 140, Utc(1, 9), "2026-08-01");
        Assert.Equal(40, s.KWh, 6);

        s = EnergyIntegrator.Observe(s, 3, Utc(1, 10), "2026-08-01");     // suspicion
        s = EnergyIntegrator.Observe(s, 5, Utc(1, 11), "2026-08-01");     // confirmed: counting up from 0
        Assert.Equal(40, s.KWh, 6);
        Assert.Equal(5, s.LastCounterKWh!.Value, 6);

        s = EnergyIntegrator.Observe(s, 9, Utc(1, 12), "2026-08-01");     // now measured against the new base
        Assert.Equal(44, s.KWh, 6);
    }

    [Fact]
    public void ACumulativeTotal_NeverFalls_WhateverTheCounterDoes()
    {
        // The invariant everything downstream depends on: Home Assistant and EmonCMS read a drop as a meter
        // reset and rewrite history that was already correct.
        var s = EnergyState.Empty;
        var last = 0.0;
        foreach (var reading in new[] { 10.0, 20, 0, 21, 22, 3, 4, 5, 0, 0, 1, 900, 901 })
        {
            s = EnergyIntegrator.Observe(s, reading, Utc(1, 8), "2026-08-01");
            Assert.True(s.KWh >= last, $"total fell after reading {reading}");
            last = s.KWh;
        }
        // A stray dip followed by recovery must not leak the counter's face value — the 791.9 kWh bug.
        var stray = EnergyIntegrator.Observe(EnergyState.Empty, 750, Utc(1, 8), "2026-08-01");
        stray = EnergyIntegrator.Observe(stray, 0, Utc(1, 9), "2026-08-01");
        stray = EnergyIntegrator.Observe(stray, 791.9, Utc(1, 10), "2026-08-01");
        Assert.Equal(41.9, stray.KWh, 6);

        // Not asserted, and deliberately so: a *confirmed* reset (two lows) followed by a jump back to a
        // large value is genuinely ambiguous — the counter either restarted and climbed fast, or the low
        // period was a longer glitch. Nothing in the reading distinguishes them, so this counts the rise
        // from the adopted base. Bounding it would need a plausible-rate ceiling, which needs a capacity
        // this class does not have. Tracked in #314.
    }

    [Fact]
    public void AGapInTheSnapshots_LosesNoEnergyFromACounter()
    {
        // The integrator cannot count a gap — it does not know what the power did across it, and refuses to
        // guess. A counter has no such problem: the device kept counting, so the whole gap arrives in the
        // next delta. This is why a metered outlet gets Observe and not Accumulate.
        var s = EnergyIntegrator.Observe(EnergyState.Empty, 500, Utc(1, 8), "2026-08-01");
        s = EnergyIntegrator.Observe(s, 512, Utc(1, 20), "2026-08-01");   // PDU unreachable for 12 hours

        Assert.Equal(12, s.KWh, 6);
        Assert.Equal(0, s.UnmeasuredSeconds);
    }

    [Fact]
    public void ADerivedNodeAndAMeteredOutlet_AreComparableOnTheDay_ThoughNotOnTheLifetime()
    {
        // The bug, in miniature. The outlet's firmware has counted 7,371 kWh since it was commissioned; the
        // inverter's total has been derived for an hour. Their lifetime figures cannot be compared — that is
        // what drew a 740 kWh inverter feeding an 8,358 kWh panel. Their daily figures can.
        const string day = "2026-08-01";

        var outlet = EnergyIntegrator.Observe(EnergyState.Empty, 7371.006, Utc(1, 8), day);
        outlet = EnergyIntegrator.Observe(outlet, 7372.006, Utc(1, 9), day);

        var derived = new EnergyState(740, default, 0, 0);
        derived = EnergyIntegrator.Accumulate(derived, 1000, Utc(1, 8), MaxGap, day);
        for (var m = 1; m <= 60; m++)
            derived = EnergyIntegrator.Accumulate(derived, 1000, Utc(1, 8).AddMinutes(m), MaxGap, day);

        // Their lifetime figures remain wildly apart, and are left that way — HA has history against them.
        Assert.Equal(7372.006, outlet.LastCounterKWh!.Value, 6);
        Assert.Equal(741, derived.KWh, 6);

        // One kWh each over the same hour, from two counters whose lifetime figures differ by 6,600.
        Assert.Equal(1, outlet.PeriodKWh, 6);
        Assert.Equal(1, derived.PeriodKWh, 6);
    }

    [Fact]
    public void AStartHour_MovesTheBoundaryOffMidnight()
    {
        // A utility day that runs 06:00 to 06:00. 05:00 still belongs to the day that began yesterday at 06.
        Assert.Equal("2026-08-01", EnergyPeriod.KeyFor(Utc(2, 11), Zone, 6));   // 05:00 local on the 2nd
        Assert.Equal("2026-08-02", EnergyPeriod.KeyFor(Utc(2, 13), Zone, 6));   // 07:00 local on the 2nd
    }

    [Fact]
    public void AnOutOfRangeStartHour_IsMidnight_NotAnException()
    {
        // A typo in config must not take the sampler down or silently shift the day by a random amount.
        Assert.Equal(EnergyPeriod.KeyFor(Utc(2, 7), Zone, 0), EnergyPeriod.KeyFor(Utc(2, 7), Zone, 99));
        Assert.Equal(EnergyPeriod.KeyFor(Utc(2, 7), Zone, 0), EnergyPeriod.KeyFor(Utc(2, 7), Zone, -3));
    }

    [Fact]
    public void TheNextRollover_IsTheNextBoundary_AndAlwaysAhead()
    {
        // 21:00 local on the 1st (03:00 UTC on the 2nd) → midnight local, which is 06:00 UTC on the 2nd.
        Assert.Equal(Utc(2, 6), EnergyPeriod.NextRollover(Utc(2, 3), Zone));

        // Standing exactly on a boundary rolls to the next one rather than reporting "now".
        Assert.Equal(Utc(3, 6), EnergyPeriod.NextRollover(Utc(2, 6), Zone));
    }

    [Fact]
    public void TheNextRollover_FollowsTheStartHour()
    {
        // Day starts 06:00 local = 12:00 UTC. At 05:00 local on the 2nd the next boundary is 06:00 that day.
        Assert.Equal(Utc(2, 12), EnergyPeriod.NextRollover(Utc(2, 11), Zone, 6));
        // An hour later it has passed, so the next one is the following day.
        Assert.Equal(Utc(3, 12), EnergyPeriod.NextRollover(Utc(2, 13), Zone, 6));
    }

    [Fact]
    public void TheKeyChangesExactlyWhenTheRolloverSaysItWill()
    {
        // The two have to agree, or the GUI counts down to a moment the sampler doesn't act on.
        foreach (var hour in new[] { 0, 6, 23 })
        {
            var now = Utc(2, 3);
            var next = EnergyPeriod.NextRollover(now, Zone, hour);
            Assert.Equal(EnergyPeriod.KeyFor(now, Zone, hour), EnergyPeriod.KeyFor(next.AddSeconds(-1), Zone, hour));
            Assert.NotEqual(EnergyPeriod.KeyFor(now, Zone, hour), EnergyPeriod.KeyFor(next, Zone, hour));
        }
    }

    [Fact]
    public void AnUnknownTimeZone_FallsBackToLocal_AndSaysSo()
    {
        string? warned = null;
        var zone = EnergyPeriod.Resolve("Mars/Olympus_Mons", m => warned = m);

        Assert.Equal(TimeZoneInfo.Local, zone);
        Assert.Contains("Mars/Olympus_Mons", warned);
    }

    [Fact]
    public void ABlankTimeZone_IsTheHostsOwn()
        => Assert.Equal(TimeZoneInfo.Local, EnergyPeriod.Resolve("  "));
}
