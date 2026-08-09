using rPDU2MQTT.Core.Flow;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// "Today so far" starts where the counters last re-based.
///
/// <para>
/// Not the last 24 hours, and not the browser's midnight: the daily totals are cut on the configured
/// boundary, so a chart of "today" anchored anywhere else covers a different day from the totals beside it.
/// </para>
/// </summary>
public class TodayWindowTests
{
    private static readonly TimeZoneInfo Chicago = TimeZoneInfo.FindSystemTimeZoneById("America/Chicago");

    /// <summary>
    /// The window the endpoint builds. Calls the production rule rather than restating it — stated here
    /// instead, the test passed just as happily with the endpoint charting a flat 24 hours.
    /// </summary>
    private static (DateTime Start, DateTime End) Window(DateTime nowUtc, TimeZoneInfo zone, int startHour)
        => (EnergyPeriod.PeriodStart(nowUtc, zone, startHour), nowUtc);

    [Fact]
    public void ItBeginsAtTheBoundaryTheCountersReBaseOn()
    {
        // 14:05 CDT on the 8th: today began at midnight CDT, which is 05:00Z.
        var now = new DateTime(2026, 8, 8, 19, 5, 0, DateTimeKind.Utc);

        var (start, end) = Window(now, Chicago, 0);

        Assert.Equal(new DateTime(2026, 8, 8, 5, 0, 0, DateTimeKind.Utc), start);
        Assert.Equal(now, end);
    }

    [Fact]
    public void AConfiguredStartHourMovesIt()
    {
        // A day that starts at 06:00 local: at 14:05 the window began at 06:00 that morning (11:00Z).
        var now = new DateTime(2026, 8, 8, 19, 5, 0, DateTimeKind.Utc);

        var (start, _) = Window(now, Chicago, 6);

        Assert.Equal(new DateTime(2026, 8, 8, 11, 0, 0, DateTimeKind.Utc), start);
    }

    [Fact]
    public void JustAfterTheBoundaryTheWindowIsShort_NotAWholeDay()
    {
        // 00:05 CDT. "Today" is five minutes long, and saying so is the point — a fixed 24-hour window here
        // would chart most of yesterday under today's name.
        var now = new DateTime(2026, 8, 8, 5, 5, 0, DateTimeKind.Utc);

        var (start, end) = Window(now, Chicago, 0);

        Assert.Equal(TimeSpan.FromMinutes(5), end - start);
    }

    [Fact]
    public void ItSurvivesAClockChange()
    {
        // The morning the clocks went forward. Subtracting a day from the next rollover lands an hour
        // inside the previous period and charts an hour of yesterday as today.
        var now = new DateTime(2026, 3, 8, 18, 0, 0, DateTimeKind.Utc);   // 13:00 CDT, spring-forward day

        var (start, _) = Window(now, Chicago, 0);

        var local = EnergyPeriod.Local(start, Chicago);
        Assert.Equal(0, local.Hour);
        Assert.Equal(new DateTime(2026, 3, 8), local.Date);
    }

    [Fact]
    public void TheWindowAndTheDailyTotalAgreeOnWhichDayItIs()
    {
        // The property that matters: the day the window starts in is the day the totals are filed under.
        var now = new DateTime(2026, 8, 8, 19, 5, 0, DateTimeKind.Utc);

        var (start, _) = Window(now, Chicago, 0);

        Assert.Equal(EnergyPeriod.KeyFor(now, Chicago, 0), EnergyPeriod.KeyFor(start, Chicago, 0));
    }
}
