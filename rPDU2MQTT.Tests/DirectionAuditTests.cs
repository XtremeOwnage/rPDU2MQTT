using rPDU2MQTT.Core.Flow;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// Catching an inverted split sign convention. It is invisible without a cross-check: the diagram still
/// balances and the numbers still look plausible — a charging battery simply reads as discharging, and gets
/// added to the house total where it should be subtracted.
/// </summary>
public class DirectionAuditTests
{
    [Fact]
    public void TheLiveCase_IsCaught()
    {
        // Solar Assistant publishes battery power positive while charging, so a battery taking 1.65 kW in was
        // drawn as 1.77 kW coming out — and home read 11.3 kW against an actual 7.0 kW. Today's metered
        // energy (11.7 kWh in, 0.1 kWh out) says charging, flatly contradicting the power sign.
        Assert.True(DirectionAudit.LooksInverted(powerOut: 1771, powerIn: 0, energyOutToday: 0.1, energyInToday: 11.7));

        var msg = DirectionAudit.Explain("battery", 1771, 0, 0.1, 11.7);
        Assert.Contains("Scale: -1", msg);
        Assert.Contains("battery", msg);
    }

    [Fact]
    public void TheOtherDirection_IsCaughtToo()
        => Assert.True(DirectionAudit.LooksInverted(powerOut: 0, powerIn: 2000, energyOutToday: 14.0, energyInToday: 0.2));

    [Fact]
    public void AgreementIsNotAWarning()
    {
        // Discharging, and the day says discharging.
        Assert.False(DirectionAudit.LooksInverted(1771, 0, 11.7, 0.1));
        // Charging, and the day says charging.
        Assert.False(DirectionAudit.LooksInverted(0, 1771, 0.1, 11.7));
    }

    [Fact]
    public void AnIdleNode_IsNotEvidence()
    {
        // A few watts of standby says nothing about direction, and a warning that fires on noise is a
        // warning that gets ignored.
        Assert.False(DirectionAudit.LooksInverted(5, 0, 0.1, 11.7));
        Assert.False(DirectionAudit.LooksInverted(0, 0, 0.1, 11.7));
    }

    [Fact]
    public void ADayThatWentBothWays_IsNotEvidence()
    {
        // A battery that cycled today says nothing about which way it is going right now.
        Assert.False(DirectionAudit.LooksInverted(1771, 0, 6.0, 7.0));
        // Nor does a day with almost no energy either way.
        Assert.False(DirectionAudit.LooksInverted(1771, 0, 0.0, 0.2));
    }

    [Fact]
    public void ANodeWithNoEnergyCountersAtAll_IsNeverFlagged()
        => Assert.False(DirectionAudit.LooksInverted(1771, 0, 0, 0));
}
