using rPDU2MQTT.Core.Flow;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>A completed period is read at its own rollover, not at "now minus 24 hours".</summary>
public class PeriodEndsTests
{
    private static readonly TimeZoneInfo Chicago = TimeZoneInfo.FindSystemTimeZoneById("America/Chicago");

    [Fact]
    public void ACompletedDayIsReadAtItsOwnRollover_NotAtTheCurrentTimeOfDay()
    {
        // 14:05 local on the 8th. The bar for the 6th must be the 6th's total, not the 6th up to 14:05.
        var now = new DateTime(2026, 8, 8, 19, 5, 0, DateTimeKind.Utc);   // 14:05 CDT

        var ends = EnergyPeriod.RecentPeriodEnds(now, Chicago, 0, 3);

        Assert.Equal(3, ends.Count);
        Assert.Equal(["2026-08-06", "2026-08-07", "2026-08-08"], ends.Select(e => e.Day));
        // 23:59:59 local on the 6th, which is 04:59:59Z on the 7th.
        Assert.Equal(new DateTime(2026, 8, 7, 4, 59, 59, DateTimeKind.Utc), ends[0].AtUtc);
        Assert.Equal(new DateTime(2026, 8, 8, 4, 59, 59, DateTimeKind.Utc), ends[1].AtUtc);
    }

    [Fact]
    public void TheCurrentPeriodIsReadNow_AndFlaggedAsUnfinished()
    {
        var now = new DateTime(2026, 8, 8, 19, 5, 0, DateTimeKind.Utc);

        var ends = EnergyPeriod.RecentPeriodEnds(now, Chicago, 0, 3);

        Assert.Equal(now, ends[^1].AtUtc);
        Assert.False(ends[^1].Complete);
        Assert.All(ends.Take(2), e => Assert.True(e.Complete));
    }

    [Fact]
    public void AConfiguredStartHourMovesTheBoundary_AndTheDayItBelongsTo()
    {
        // A day that starts at 06:00 ends at 05:59:59 the next morning, and that reading belongs to the
        // day it started on.
        var now = new DateTime(2026, 8, 8, 19, 5, 0, DateTimeKind.Utc);

        var ends = EnergyPeriod.RecentPeriodEnds(now, Chicago, 6, 2);

        Assert.Equal("2026-08-07", ends[0].Day);
        // 05:59:59 local on the 8th = 10:59:59Z.
        Assert.Equal(new DateTime(2026, 8, 8, 10, 59, 59, DateTimeKind.Utc), ends[0].AtUtc);
    }

    [Fact]
    public void ClockChangesDoNotSlideTheBoundaries()
    {
        // Across the US spring-forward (2026-03-08). Subtracting 24 hours would put one boundary an hour
        // inside the wrong day and read that day's counter before it had re-based.
        var now = new DateTime(2026, 3, 10, 18, 0, 0, DateTimeKind.Utc);

        var ends = EnergyPeriod.RecentPeriodEnds(now, Chicago, 0, 4);

        Assert.Equal(["2026-03-07", "2026-03-08", "2026-03-09", "2026-03-10"], ends.Select(e => e.Day));
        // Every completed reading is a second before its own local midnight, whatever the offset was.
        foreach (var e in ends.Where(e => e.Complete))
        {
            var local = EnergyPeriod.Local(e.AtUtc, Chicago);
            Assert.Equal(23, local.Hour);
            Assert.Equal(59, local.Minute);
            Assert.Equal(59, local.Second);
        }
    }

    [Fact]
    public void EveryViewOfTheLastNDaysAsksTheSameQuestion()
    {
        // One answer to "which instants are the last N days", used by the Trends charts and by the span
        // view on the Flow and Energy pages. Two answers meant the second one kept sampling at the current
        // time of day long after the first was fixed.
        var at = new DateTime(2026, 8, 8, 19, 5, 0, DateTimeKind.Utc);

        var week = EnergyPeriod.RecentPeriodEnds(at, Chicago, 0, 7);

        Assert.Equal(7, week.Count);
        // Each completed day at its own rollover, not at 14:05 on that day.
        Assert.All(week.Take(6), e => Assert.Equal(new TimeSpan(4, 59, 59), e.AtUtc.TimeOfDay));
        Assert.All(week.Take(6), e => Assert.True(e.Complete));
    }

    [Fact]
    public void YesterdayIsTheWholePeriodBeforeThisOne()
    {
        // 14:05 CDT on the 8th. "Today" runs from local midnight to now; "yesterday" is the 7th end to end.
        var now = new DateTime(2026, 8, 8, 19, 5, 0, DateTimeKind.Utc);

        var today = EnergyPeriod.Window(now, Chicago, 0, 0);
        Assert.Equal(new DateTime(2026, 8, 8, 5, 0, 0, DateTimeKind.Utc), today.Start);
        Assert.Equal(now, today.End);

        var yesterday = EnergyPeriod.Window(now, Chicago, 0, 1);
        Assert.Equal(new DateTime(2026, 8, 7, 5, 0, 0, DateTimeKind.Utc), yesterday.Start);
        Assert.Equal(new DateTime(2026, 8, 8, 4, 59, 59, DateTimeKind.Utc), yesterday.End);
    }

    [Fact]
    public void YesterdayKeepsItsOwnLengthAcrossAClockChange()
    {
        // The spring-forward day is 23 hours long. Subtracting 24 would start it an hour into the 7th.
        var now = new DateTime(2026, 3, 9, 18, 0, 0, DateTimeKind.Utc);

        var (start, end) = EnergyPeriod.Window(now, Chicago, 0, 1);

        Assert.Equal("2026-03-08", EnergyPeriod.KeyFor(start, Chicago, 0));
        Assert.Equal("2026-03-08", EnergyPeriod.KeyFor(end, Chicago, 0));
        Assert.Equal(0, EnergyPeriod.Local(start, Chicago).Hour);
        Assert.Equal(23, (end - start).TotalHours, 3);
    }

    [Fact]
    public void TheDaysComeBackOldestFirst_OneEach()
    {
        var ends = EnergyPeriod.RecentPeriodEnds(DateTime.UtcNow, TimeZoneInfo.Utc, 0, 30);

        Assert.Equal(30, ends.Count);
        Assert.Equal(30, ends.Select(e => e.Day).Distinct().Count());
        Assert.Equal(ends.Select(e => e.AtUtc).OrderBy(x => x), ends.Select(e => e.AtUtc));
    }
}
