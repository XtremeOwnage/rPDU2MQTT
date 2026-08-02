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
        Assert.True(DirectionAudit.LooksInverted(powerOut: 1771, powerIn: 0, outRiseKWh: 0.0, inRiseKWh: 0.9));

        var msg = DirectionAudit.Explain("battery", 1771, 0, 0.0, 0.9);
        Assert.Contains("Scale: -1", msg);
        Assert.Contains("battery", msg);
    }

    [Fact]
    public void TheOtherDirection_IsCaughtToo()
        => Assert.True(DirectionAudit.LooksInverted(powerOut: 0, powerIn: 2000, outRiseKWh: 1.4, inRiseKWh: 0.0));

    [Fact]
    public void AgreementIsNotAWarning()
    {
        // Discharging, and the day says discharging.
        Assert.False(DirectionAudit.LooksInverted(1771, 0, 0.9, 0.0));
        // Charging, and the day says charging.
        Assert.False(DirectionAudit.LooksInverted(0, 1771, 0.0, 0.9));
    }

    [Fact]
    public void AnIdleNode_IsNotEvidence()
    {
        // A few watts of standby says nothing about direction, and a warning that fires on noise is a
        // warning that gets ignored.
        Assert.False(DirectionAudit.LooksInverted(5, 0, 0.0, 0.9));
        Assert.False(DirectionAudit.LooksInverted(0, 0, 0.0, 0.9));
    }

    [Fact]
    public void AWindowThatWentBothWays_IsNotEvidence()
    {
        // Both counters moving means the node reversed inside the window, which is normal.
        Assert.False(DirectionAudit.LooksInverted(1771, 0, 6.0, 7.0));
        // Nor does a window in which almost nothing moved either way.
        Assert.False(DirectionAudit.LooksInverted(1771, 0, 0.0, 0.05));
    }

    [Fact]
    public void AGridExportingAtNoonOnAnImportHeavyDay_IsNotAFalsePositive()
    {
        // The live false positive. A grid exporting 150 W mid-afternoon after importing 25 kWh overnight is
        // simply telling the truth, and warning about it teaches people to ignore warnings. Comparing against
        // a recent window instead of the day is what fixes it: over the last ten minutes nothing was
        // imported, so there is no contradiction to report.
        Assert.False(DirectionAudit.LooksInverted(powerOut: 0, powerIn: 150, outRiseKWh: 0.0, inRiseKWh: 0.03));
    }

    [Fact]
    public void TheSameGrid_IsStillCaughtWhenItGenuinelyContradicts()
    {
        // Same node, same direction of power — but this time the import counter really is the one climbing.
        Assert.True(DirectionAudit.LooksInverted(powerOut: 0, powerIn: 150, outRiseKWh: 0.9, inRiseKWh: 0.0));
    }

    [Fact]
    public void ANodeWithNoEnergyCountersAtAll_IsNeverFlagged()
        => Assert.False(DirectionAudit.LooksInverted(1771, 0, 0, 0));
}
