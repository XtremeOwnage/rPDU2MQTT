using rPDU2MQTT.Integrations.EmonCms;

namespace rPDU2MQTT.Tests;

/// <summary>Which EmonCMS inputs and feeds the cleanup may delete: only this bridge's, and only what it no longer sends or provisions.</summary>
public class EmonCmsStaleTests
{
    private static readonly HashSet<string> OurNode = new(StringComparer.OrdinalIgnoreCase) { "rpdu2mqtt" };

    private static EmonDesiredState Desired(params string[] feeds)
        => new(feeds.Select(n => new DesiredFeed(n, "rpdu2mqtt", 0, 10, 1)).ToList(), [], [new DesiredVirtualFeed("Solar power", "Virtual", "solar_realpower")]);

    [Fact]
    public void AnInputUnderOurNodeThatIsNoLongerSent_IsStale_AndNothingElseIs()
    {
        var inputs = new List<EmonInput>
        {
            new(1, "solar_realpower", "1:10", "rpdu2mqtt"),
            new(2, "old_outlet_power", "1:11", "rpdu2mqtt"),
            new(3, "old_outlet_power", "1:12", "IotaWatt"),
        };

        var plan = EmonCmsFeedPlanner.Stale(["solar_realpower"], OurNode, Desired("solar_realpower"), inputs, [], "rpdu2mqtt", "Virtual");

        Assert.Null(plan.Refused);
        Assert.Equal([2], plan.Inputs.Select(i => i.Id));
    }

    [Fact]
    public void AFeedUnderOurTagThatIsNoLongerPlanned_IsStale_ButAnotherTagsFeedIsNot()
    {
        var feeds = new List<EmonFeed>
        {
            new(10, "solar_realpower", "rpdu2mqtt"),
            new(11, "old_outlet_power", "rpdu2mqtt"),
            new(12, "old_outlet_power", "IotaWatt"),
        };

        var plan = EmonCmsFeedPlanner.Stale(["solar_realpower"], OurNode, Desired("solar_realpower"), [], feeds, "rpdu2mqtt", "Virtual");

        Assert.Equal([11], plan.Feeds.Select(f => f.Id));
    }

    /// <summary>A virtual tag can be shared: only virtual feeds reading this bridge's feeds, or a feed that is gone, are its to delete.</summary>
    [Fact]
    public void AVirtualFeedIsOursOnlyWhenItReadsOurFeedOrAFeedThatIsGone()
    {
        var feeds = new List<EmonFeed>
        {
            new(10, "solar_realpower", "rpdu2mqtt"),
            new(11, "old_outlet_power", "rpdu2mqtt"),
            new(20, "Solar power", "Virtual", "53:10"),
            new(21, "Old outlet power", "Virtual", "53:11"),
            new(22, "Deleted feed power", "Virtual", "process__source_feed_data_time:999"),
            new(23, "Someone else's power", "Virtual", "53:30"),
            new(30, "house_power", "IotaWatt"),
        };

        var plan = EmonCmsFeedPlanner.Stale(["solar_realpower"], OurNode, Desired("solar_realpower"), [], feeds, "rpdu2mqtt", "Virtual");

        Assert.Equal([11, 21, 22], plan.Feeds.Select(f => f.Id).OrderBy(x => x));
    }

    /// <summary>With nothing sent or planned every item would look stale, so nothing is offered.</summary>
    [Fact]
    public void BeforeTheFirstPoll_NothingIsOffered()
    {
        var plan = EmonCmsFeedPlanner.Stale([], OurNode, Desired(), [new(1, "anything", "", "rpdu2mqtt")], [new(10, "anything", "rpdu2mqtt")], "rpdu2mqtt", "Virtual");

        Assert.NotNull(plan.Refused);
        Assert.Empty(plan.Inputs);
        Assert.Empty(plan.Feeds);
    }

    [Theory]
    [InlineData("53:1179", 1179)]
    [InlineData("process__source_feed_data_time:42,55:43", 42)]
    [InlineData("1:10", null)]
    [InlineData(null, null)]
    public void SourceFeedId_ReadsTheFirstSourceFeedStep(string? processList, int? expected)
        => Assert.Equal(expected, EmonCmsFeedPlanner.SourceFeedId(processList));
}
