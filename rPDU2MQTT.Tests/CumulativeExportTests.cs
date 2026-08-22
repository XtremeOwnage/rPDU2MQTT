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
}
