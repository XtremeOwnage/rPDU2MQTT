using rPDU2MQTT.Core.Flow;

namespace rPDU2MQTT.Tests;

/// <summary>The instants a Trends window is sampled at: any step from a minute to a day, never more points than a chart can use.</summary>
public class SeriesWindowTests
{
    private static readonly DateTime T0 = new(2026, 9, 1, 0, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void ClampStep_HoldsARequestToAMinuteThroughADay()
    {
        Assert.Equal(300, SeriesWindow.ClampStep(null, 300));
        Assert.Equal(60, SeriesWindow.ClampStep(5, 300));
        Assert.Equal(3600, SeriesWindow.ClampStep(3600, 300));
        Assert.Equal(86400, SeriesWindow.ClampStep(999_999, 300));
    }

    /// <summary>Seven days at an hour is 169 instants, well inside the cap, so the step is the one asked for.</summary>
    [Fact]
    public void Instants_SevenDaysAtAnHour_AreHourly()
    {
        var at = SeriesWindow.Instants(T0, T0.AddDays(7), 3600);

        Assert.Equal(169, at.Count);
        Assert.Equal(T0, at[0]);
        Assert.Equal(T0.AddDays(7), at[^1]);
        Assert.All(at.Skip(1).Zip(at), p => Assert.Equal(TimeSpan.FromHours(1), p.First - p.Second));
    }

    /// <summary>A year at one minute is half a million instants; the step widens until it fits the cap.</summary>
    [Fact]
    public void Instants_AYearAtAMinute_AreWidenedToTheCap()
    {
        var at = SeriesWindow.Instants(T0, T0.AddDays(366), 60);

        Assert.InRange(at.Count, SeriesWindow.MaxPoints - 1, SeriesWindow.MaxPoints);
        Assert.True((at[1] - at[0]).TotalSeconds > 60);
        Assert.Equal((int)(at[1] - at[0]).TotalSeconds, SeriesWindow.Fit(TimeSpan.FromDays(366), 60));
    }

    /// <summary>A window shorter than one step still has an instant to read.</summary>
    [Fact]
    public void Instants_AWindowShorterThanAStep_IsNeverEmpty()
    {
        Assert.Single(SeriesWindow.Instants(T0, T0.AddSeconds(30), 3600));
        Assert.Single(SeriesWindow.Instants(T0.AddMinutes(1), T0, 3600));
    }
}
