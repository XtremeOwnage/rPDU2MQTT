using rPDU2MQTT.Core.Flow;

namespace rPDU2MQTT.Tests;

/// <summary>
/// The guard on a lifetime counter. These figures feed sensors declared <c>state_class: total_increasing</c>,
/// where Home Assistant reads any decrease as a meter reset and records the next reading as a delta from
/// zero — so a dip does not lose a reading, it fabricates a whole counter's worth of usage (#403).
/// </summary>
public class CumulativeExportTests
{
    [Fact]
    public void ARisingCounterIsPublished()
    {
        var guard = new CumulativeExport();

        Assert.Equal(10, guard.Publish("grid|energy", 10));
        Assert.Equal(11, guard.Publish("grid|energy", 11));
        Assert.Equal(11, guard.Publish("grid|energy", 11));   // unchanged is not a decrease
        Assert.Empty(guard.Withheld);
    }

    /// <summary>
    /// The case that does the damage: a roll-up sums the links whose flow is known, so a contributor going
    /// stale makes the parent's total smaller without anything being wrong with the meter.
    /// </summary>
    [Fact]
    public void AContributorGoingStaleDoesNotPublishASmallerTotal()
    {
        var guard = new CumulativeExport();
        guard.Publish("panel|energy", 14_616);

        Assert.Null(guard.Publish("panel|energy", 9_800));

        var (key, reason) = Assert.Single(guard.Withheld);
        Assert.Equal("panel|energy", key);
        Assert.Contains("14616", reason.Replace(",", ""));
    }

    /// <summary>…and it publishes again by itself once the missing contributor comes back.</summary>
    [Fact]
    public void ItRecoversWhenTheReadingPassesItsOldPeak()
    {
        var guard = new CumulativeExport();
        guard.Publish("panel|energy", 100);
        Assert.Null(guard.Publish("panel|energy", 60));

        Assert.Equal(101, guard.Publish("panel|energy", 101));
        Assert.Empty(guard.Withheld);
    }

    /// <summary>Nothing measured stays nothing measured: absent is not a decrease, and never becomes one.</summary>
    [Fact]
    public void AnAbsentReadingIsNotWithheld()
    {
        var guard = new CumulativeExport();
        guard.Publish("grid|energy", 10);

        Assert.Null(guard.Publish("grid|energy", null));
        Assert.Empty(guard.Withheld);
        Assert.Equal(12, guard.Publish("grid|energy", 12));
    }

    /// <summary>Each counter is judged on its own history.</summary>
    [Fact]
    public void CountersDoNotInterfere()
    {
        var guard = new CumulativeExport();
        guard.Publish("grid|energy", 100);

        Assert.Equal(5, guard.Publish("solar|energy", 5));
        Assert.Equal(6, guard.Publish("grid|energy_in", 6));
    }

    /// <summary>The first reading of a counter is its own baseline, whatever it is.</summary>
    [Fact]
    public void TheFirstReadingIsAlwaysPublished()
        => Assert.Equal(14_616.54, new CumulativeExport().Publish("grid|energy", 14_616.54));
    /// <summary>
    /// The 0.003 kWh dip that once cost 20 outlets their sensor. It is still withheld: a carve-out for
    /// "small" decreases is what let the mark drift down, and a mark that drifts down is not a mark.
    /// The right answer to save-ordering jitter is to stop the jitter, not to publish a decrease.
    /// </summary>
    [Fact]
    public void ASmallDipIsWithheldLikeAnyOther()
    {
        var guard = new CumulativeExport();
        guard.Publish("outlet:pdu_1:1|energy", 832.613);

        Assert.Null(guard.Publish("outlet:pdu_1:1|energy", 832.610));
        Assert.Single(guard.Withheld);

        // And the mark did not move down with it: the next honest reading still measures against 832.613.
        Assert.Null(guard.Publish("outlet:pdu_1:1|energy", 832.612));
        Assert.Equal(832.614, guard.Publish("outlet:pdu_1:1|energy", 832.614));
    }

    /// <summary>
    /// Live on 2026-09-10: the solar mark stood at 725.889 and the dedicated PV counter read 183.5. The
    /// six-hour re-baseline published that step down at 04:10, Home Assistant read a meter reset, and the
    /// whole 183.5 kWh counter was booked as one hour of production. No elapsed time releases a mark.
    /// </summary>
    [Fact]
    public void AMarkNeverReBaselinesOntoALowerSeriesHoweverLongItStaysDown()
    {
        var guard = new CumulativeExport();
        guard.Publish("solar|energy", 725.889);

        for (var i = 0; i < 500; i++)
            Assert.Null(guard.Publish("solar|energy", 183.5 + i * 0.01));

        Assert.Single(guard.Withheld);
        Assert.Contains("725.889", guard.Withheld.Single().Reason);
    }

    /// <summary>A key held down does not hold back any other key.</summary>
    [Fact]
    public void WithholdingIsPerKey()
    {
        var guard = new CumulativeExport();
        guard.Publish("solar|energy", 700);
        guard.Publish("grid|energy", 10);

        Assert.Null(guard.Publish("solar|energy", 183.5));
        Assert.Equal(11, guard.Publish("grid|energy", 11));
    }

    /// <summary>Clearing the stored mark is the deliberate way to move one, and it is the only way.</summary>
    [Fact]
    public void ResetIsTheOnlyReBaseline()
    {
        var guard = new CumulativeExport();
        guard.Publish("solar|energy", 725.889);
        Assert.Null(guard.Publish("solar|energy", 183.5));

        guard.Reset();

        Assert.Equal(183.5, guard.Publish("solar|energy", 183.5));
        Assert.Empty(guard.Withheld);
    }
}
