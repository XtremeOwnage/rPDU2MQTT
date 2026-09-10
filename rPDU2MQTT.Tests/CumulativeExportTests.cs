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
    private static readonly DateTime T0 = new(2026, 9, 9, 8, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void ADipInsideTheConsumersOwnResetThresholdIsPublished()
    {
        // Live: 20 outlets went dark over a thousandth of a kWh. The mark is written on publish and the
        // accumulated state on its own cadence, so a restart brings the value back a hair behind the mark.
        // Home Assistant does not read a decrease that small as a reset, so withholding it bought nothing.
        var guard = new CumulativeExport();
        guard.Publish("outlet:pdu_1:1|energy", 832.613, T0);

        Assert.Equal(832.610, guard.Publish("outlet:pdu_1:1|energy", 832.610, T0.AddMinutes(1)));
        Assert.Empty(guard.Withheld);
    }

    [Fact]
    public void AMarkLeftBehindByADifferentSeriesReBaselinesInsteadOfWithholdingForever()
    {
        // Live: the solar mark latched at 725.889 — the MPPTs' integrated totals, summed in while the PV
        // counter had not yet arrived — and the real counter reads 183.5. It can never climb back, so the
        // sensor published nothing at all for as long as the mark stood.
        var guard = new CumulativeExport();
        guard.Publish("solar|energy", 725.889, T0);

        // A stale contributor comes back; a re-based series never does. Inside the window it is still held.
        Assert.Null(guard.Publish("solar|energy", 183.5, T0.AddHours(1)));
        Assert.Single(guard.Withheld);

        var due = T0.AddHours(1) + CumulativeExport.RebaselineAfter;
        Assert.Equal(183.5, guard.Publish("solar|energy", 183.5, due));
        Assert.Empty(guard.Withheld);
        // The mark came with it, so the series carries on from where it really is.
        Assert.Equal(183.6, guard.Publish("solar|energy", 183.6, due.AddMinutes(1)));
    }

    [Fact]
    public void TheWindowStartsWhenTheReadingFirstWentDown_NotWhenItWasLastSeen()
    {
        var guard = new CumulativeExport();
        guard.Publish("panel|energy", 1000, T0);
        Assert.Null(guard.Publish("panel|energy", 400, T0.AddHours(1)));
        Assert.Null(guard.Publish("panel|energy", 400, T0.AddHours(3)));

        // The window runs from the first low reading, so a later one does not restart it.
        Assert.Equal(400, guard.Publish("panel|energy", 400, T0.AddHours(1) + CumulativeExport.RebaselineAfter));
    }

    [Fact]
    public void ARecoveryInsideTheWindowClearsTheClock()
    {
        // The stale-contributor case must not creep toward a re-baseline across separate outages.
        var guard = new CumulativeExport();
        guard.Publish("panel|energy", 1000, T0);
        Assert.Null(guard.Publish("panel|energy", 400, T0.AddHours(5)));
        Assert.Equal(1000, guard.Publish("panel|energy", 1000, T0.AddHours(5.5)));   // contributor came back

        Assert.Null(guard.Publish("panel|energy", 400, T0.AddHours(6)));             // a fresh outage
        Assert.Null(guard.Publish("panel|energy", 400, T0.AddHours(11)));            // still inside its own window
    }

}
