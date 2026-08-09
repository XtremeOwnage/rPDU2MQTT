using rPDU2MQTT.Core.Flow;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// Energy over a window of days. Daily totals all re-base at the same moment, so they add up; a day the
/// backend has nothing for is a day missing from the sum rather than a zero, and saying which is the
/// difference between a week's energy and five days of it presented as a week.
/// </summary>
public class FlowSpanTests
{
    [Fact]
    public void DailyTotalsAddUpPerNode()
    {
        var (totals, days) = FlowSpan.Fold([
            new Dictionary<string, double> { ["solar"] = 30, ["grid"] = 5 },
            new Dictionary<string, double> { ["solar"] = 35, ["grid"] = 2 },
            new Dictionary<string, double> { ["solar"] = 20, ["grid"] = 9 },
        ]);

        Assert.Equal(85, totals["solar"]);
        Assert.Equal(16, totals["grid"]);
        Assert.Equal(3, days["solar"]);
    }

    [Fact]
    public void AMissingDayIsMissing_NotZero()
    {
        // The node was not read that day. Counting it as zero would report a lower weekly total as fact.
        var (totals, days) = FlowSpan.Fold([
            new Dictionary<string, double> { ["solar"] = 30, ["grid"] = 5 },
            new Dictionary<string, double> { ["grid"] = 2 },
        ]);

        Assert.Equal(30, totals["solar"]);
        Assert.Equal(1, days["solar"]);
        Assert.Equal(2, days["grid"]);
    }

    [Fact]
    public void AShortWindowIsNamed()
    {
        var days = new Dictionary<string, int> { ["solar"] = 5, ["grid"] = 7, ["battery"] = 1 };

        var short_ = FlowSpan.Incomplete(days, 7);

        Assert.Equal([("battery", 1), ("solar", 5)], short_);
    }

    [Fact]
    public void AWholeWindowSaysNothing()
    {
        Assert.Empty(FlowSpan.Incomplete(new Dictionary<string, int> { ["solar"] = 7, ["grid"] = 7 }, 7));
    }

    [Fact]
    public void OnlyTheDailyTotalCanBeAddedAcrossDays()
    {
        // The one metric whose days share a starting point. Lifetime counters run from unrelated epochs and
        // power is not a quantity of energy at all.
        Assert.Equal("energytoday", FlowSpan.SpannableMetric);
    }
}
