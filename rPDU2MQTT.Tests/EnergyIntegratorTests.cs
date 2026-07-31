using rPDU2MQTT.Core.Flow;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// The arithmetic behind deriving energy from power, and — more importantly — what it refuses to derive.
/// </summary>
public class EnergyIntegratorTests
{
    private static readonly DateTime T0 = new(2026, 7, 30, 12, 0, 0, DateTimeKind.Utc);
    private static readonly TimeSpan MaxGap = TimeSpan.FromMinutes(2);

    [Fact]
    public void ASteadyKilowattForAnHour_IsOneKilowattHour()
    {
        // The sanity anchor: 1000 W held for an hour is 1 kWh, however many samples it took to get there.
        var s = EnergyState.Empty;
        s = EnergyIntegrator.Accumulate(s, 1000, T0, MaxGap);
        for (var m = 1; m <= 60; m++)
            s = EnergyIntegrator.Accumulate(s, 1000, T0.AddMinutes(m), MaxGap);

        Assert.Equal(1.0, s.KWh, 6);
        Assert.Equal(0, s.UnmeasuredSeconds);
    }

    [Fact]
    public void TheFirstSample_AccumulatesNothing()
    {
        // There is no interval yet, so there is no energy yet — only a starting point.
        var s = EnergyIntegrator.Accumulate(EnergyState.Empty, 2000, T0, MaxGap);

        Assert.Equal(0, s.KWh);
        Assert.Equal(T0, s.LastSampleUtc);
        Assert.Equal(2000, s.LastPowerW);
    }

    [Fact]
    public void RampingPower_IsAveragedAcrossTheInterval()
    {
        // Trapezoidal, not "hold the last value": 0 W rising to 1000 W over an hour is 0.5 kWh, not 0 or 1.
        var s = EnergyIntegrator.Accumulate(EnergyState.Empty, 0, T0, TimeSpan.FromHours(2));
        s = EnergyIntegrator.Accumulate(s, 1000, T0.AddHours(1), TimeSpan.FromHours(2));

        Assert.Equal(0.5, s.KWh, 6);
    }

    [Fact]
    public void AGapLongerThanAllowed_CountsNoEnergyAndIsRecorded()
    {
        // The publisher died for an hour. We do not know what the load did, so none of it is counted —
        // and the fact that an hour went uncounted is reported rather than buried.
        var s = EnergyIntegrator.Accumulate(EnergyState.Empty, 1000, T0, MaxGap);
        s = EnergyIntegrator.Accumulate(s, 1000, T0.AddHours(1), MaxGap);

        Assert.Equal(0, s.KWh);
        Assert.Equal(3600, s.UnmeasuredSeconds, 3);
        // It resumes cleanly from the far side of the gap.
        s = EnergyIntegrator.Accumulate(s, 1000, T0.AddHours(1).AddMinutes(1), MaxGap);
        Assert.Equal(1000d * 60 / 3_600_000, s.KWh, 9);
    }

    [Fact]
    public void TheCounterNeverGoesBackwards()
    {
        // A duplicate sample, or a clock stepping backwards, must not subtract: consumers treat this as a
        // monotonic counter, and a decrease reads to Home Assistant as a meter reset.
        var s = EnergyIntegrator.Accumulate(EnergyState.Empty, 1000, T0, MaxGap);
        s = EnergyIntegrator.Accumulate(s, 1000, T0.AddMinutes(1), MaxGap);
        var afterOneMinute = s.KWh;

        s = EnergyIntegrator.Accumulate(s, 1000, T0.AddMinutes(1), MaxGap);          // same instant again
        s = EnergyIntegrator.Accumulate(s, 1000, T0.AddSeconds(-30), MaxGap);        // clock steps back

        Assert.Equal(afterOneMinute, s.KWh, 9);
    }

    [Fact]
    public void ZeroPower_AdvancesTimeWithoutAddingEnergy()
    {
        // Solar at night is a measurement, not a gap: the interval is counted, it just contributes nothing.
        var s = EnergyIntegrator.Accumulate(EnergyState.Empty, 0, T0, MaxGap);
        s = EnergyIntegrator.Accumulate(s, 0, T0.AddMinutes(1), MaxGap);

        Assert.Equal(0, s.KWh);
        Assert.Equal(0, s.UnmeasuredSeconds);
        Assert.Equal(T0.AddMinutes(1), s.LastSampleUtc);
    }
}
