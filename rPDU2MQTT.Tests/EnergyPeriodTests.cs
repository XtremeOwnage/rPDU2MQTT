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
    public void ACounterThatWentBackwards_WasReset_AndDoesNotDragTheTotalDown()
    {
        // A PDU reboot or firmware clear restarts the counter. What it reads now is what has accrued since
        // that moment; treating it as now-minus-last would subtract, and a cumulative total must never fall.
        var s = EnergyIntegrator.Observe(EnergyState.Empty, 100, Utc(1, 8), "2026-08-01");
        s = EnergyIntegrator.Observe(s, 140, Utc(1, 10), "2026-08-01");
        Assert.Equal(40, s.KWh, 6);

        s = EnergyIntegrator.Observe(s, 3, Utc(1, 12), "2026-08-01");

        Assert.Equal(43, s.KWh, 6);          // the 40 before the reset genuinely happened; keep it
        Assert.Equal(43, s.PeriodKWh, 6);
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
