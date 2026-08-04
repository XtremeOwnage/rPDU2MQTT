using rPDU2MQTT.Core.Flow;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// A gauge claims proportion — "this much of what is possible" — so it is only as honest as the ceiling it
/// is drawn against. These pin the cases where it must refuse to draw rather than imply one.
/// </summary>
public class GaugeTests
{
    [Fact]
    public void AReadingAgainstAStatedMax_IsItsFraction()
    {
        Assert.Equal(0.5, Gauge.Fraction(4600, 9200)!.Value, 6);
        Assert.Equal(0.0, Gauge.Fraction(0, 9200)!.Value, 6);
        Assert.Equal(1.0, Gauge.Fraction(9200, 9200)!.Value, 6);
    }

    [Fact]
    public void WithNoMaxStated_ThereIsNoGauge()
    {
        // Nobody but the operator knows an array's peak output. Inferring one from the highest reading seen
        // would redefine "full" on the first spike and make the same needle mean something different
        // tomorrow — so the caller shows the plain figure instead.
        Assert.Null(Gauge.Fraction(4600, null));
        Assert.Null(Gauge.Fraction(4600, 0));
        Assert.Null(Gauge.Fraction(4600, -1));
    }

    [Fact]
    public void AnUnknownReading_HasNoGaugeEither()
    {
        // Unknown is not zero, and a needle resting at the bottom is a claim that it is.
        Assert.Null(Gauge.Fraction(null, 9200));
        Assert.Null(Gauge.Fraction(double.NaN, 9200));
        Assert.Null(Gauge.Fraction(double.PositiveInfinity, 9200));
    }

    [Fact]
    public void PastTheCeiling_ItReadsFullAndSaysSo()
    {
        // Drawn full rather than running past the end, and flagged separately. Silently rescaling would move
        // the ceiling the operator set: the reading is not wrong, the stated maximum is too low, and those
        // are different problems.
        Assert.Equal(1.0, Gauge.Fraction(11000, 9200)!.Value, 6);
        Assert.True(Gauge.Exceeds(11000, 9200));
        Assert.False(Gauge.Exceeds(9200, 9200));
        Assert.False(Gauge.Exceeds(null, 9200));
        Assert.False(Gauge.Exceeds(11000, null));
    }

    [Fact]
    public void ANegativeReading_RestsAtZeroRatherThanWrappingRound()
    {
        // A signed source (a battery under the opposite convention) must not send the needle backwards past
        // the start of the dial.
        Assert.Equal(0.0, Gauge.Fraction(-500, 9200)!.Value, 6);
    }
}
