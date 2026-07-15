using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.EmonCms;
using rPDU2MQTT.Helpers;
using rPDU2MQTT.Models.PDU;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>EmonCmsFeedPlanner: decide feed create/link/rename actions from readings + EmonCMS state (#163).</summary>
public class EmonCmsFeedPlannerTests
{
    private static PduData OnePdu(string outletName, string displayName, params (string type, string val)[] measurements)
    {
        var outlet = new Outlet { Key = 0, Entity_Name = outletName, Entity_DisplayName = displayName };
        foreach (var (type, val) in measurements)
            outlet.Measurements.Add(new Measurement { Type = type, Value = val, Units = "" });
        var device = new Device { Key = "pdu1", Entity_Name = "rack_pdu_1", Entity_DisplayName = "Rack PDU 1" };
        device.Outlets.Add(outlet);
        var data = new PduData();
        data.Devices.Add(device);
        return data;
    }

    private static Config WithFeeds(params string[] types)
    {
        var c = new Config();
        c.EmonCMS.Node = "rpdu2mqtt";
        c.EmonCMS.InputNameTemplate = "{device}_{source}_{type}";
        c.EmonCMS.Feeds.AutoConfigure = true;
        c.EmonCMS.Feeds.Types = types.ToList();
        c.EmonCMS.Feeds.FeedNameTemplate = "{name} {type}";
        return c;
    }

    [Fact]
    public void Plan_CreatesFeeds_OnlyForSelectedTypes_WhenTheInputExists()
    {
        var data = OnePdu("o0", "Server A", ("realpower", "60"), ("energy", "12"), ("voltage", "230"));
        var config = WithFeeds("realpower", "energy");   // voltage excluded

        var inputName = MetricsHelper.EmonCmsInputName(new MeasurementReading("rack_pdu_1", "o0", "realpower", 0, "", "", "", "Server A", 1), config);
        // Inputs exist for realpower + energy but not voltage.
        var inputs = new[]
        {
            new EmonInput(1, MetricsHelper.EmonCmsInputName(Reading("realpower"), config), ""),
            new EmonInput(2, MetricsHelper.EmonCmsInputName(Reading("energy"), config), ""),
        };

        var plan = EmonCmsFeedPlanner.Plan(data, config, inputs, Array.Empty<EmonFeed>());

        Assert.Equal(2, plan.Creates.Count);
        Assert.Contains(plan.Creates, c => c.FeedName == "Server A realpower" && c.InputId == 1);
        Assert.Contains(plan.Creates, c => c.FeedName == "Server A energy" && c.InputId == 2);
        Assert.DoesNotContain(plan.Creates, c => c.FeedName.Contains("voltage"));
        Assert.Empty(plan.Renames);

        static MeasurementReading Reading(string type) => new("rack_pdu_1", "o0", type, 0, "", "", "", "Server A", 1);
    }

    [Fact]
    public void Plan_LinksToExistingFeed_InsteadOfCreatingADuplicate()
    {
        var data = OnePdu("o0", "Server A", ("realpower", "60"));
        var config = WithFeeds("realpower");
        var inputName = MetricsHelper.EmonCmsInputName(new MeasurementReading("rack_pdu_1", "o0", "realpower", 0, "", "", "", "Server A", 1), config);

        var inputs = new[] { new EmonInput(7, inputName, "") };              // input exists, not linked
        var feeds = new[] { new EmonFeed(42, "Server A realpower", "rpdu2mqtt") };  // feed already named this

        var plan = EmonCmsFeedPlanner.Plan(data, config, inputs, feeds);

        Assert.Empty(plan.Creates);
        Assert.Single(plan.Links);
        Assert.Equal((7, 42), (plan.Links[0].InputId, plan.Links[0].FeedId));
    }

    [Fact]
    public void Plan_RenamesLinkedFeed_WhenTheSourceIsRenamed()
    {
        var data = OnePdu("o0", "Server RENAMED", ("realpower", "60"));
        var config = WithFeeds("realpower");
        var inputName = MetricsHelper.EmonCmsInputName(new MeasurementReading("rack_pdu_1", "o0", "realpower", 0, "", "", "", "x", 1), config);

        var inputs = new[] { new EmonInput(7, inputName, "1:42") };          // already logging to feed 42
        var feeds = new[] { new EmonFeed(42, "Server OLD realpower", "rpdu2mqtt") };

        var plan = EmonCmsFeedPlanner.Plan(data, config, inputs, feeds);

        Assert.Empty(plan.Creates);
        Assert.Empty(plan.Links);
        Assert.Single(plan.Renames);
        Assert.Equal((42, "Server OLD realpower", "Server RENAMED realpower"), (plan.Renames[0].FeedId, plan.Renames[0].FromName, plan.Renames[0].ToName));
    }

    [Fact]
    public void Plan_LeavesAlreadyLinkedAndCorrectlyNamedFeeds_Untouched()
    {
        var data = OnePdu("o0", "Server A", ("realpower", "60"));
        var config = WithFeeds("realpower");
        var inputName = MetricsHelper.EmonCmsInputName(new MeasurementReading("rack_pdu_1", "o0", "realpower", 0, "", "", "", "x", 1), config);

        var inputs = new[] { new EmonInput(7, inputName, "1:42") };
        var feeds = new[] { new EmonFeed(42, "Server A realpower", "rpdu2mqtt") };

        var plan = EmonCmsFeedPlanner.Plan(data, config, inputs, feeds);

        Assert.Empty(plan.Creates);
        Assert.Empty(plan.Links);
        Assert.Empty(plan.Renames);
    }

    [Fact]
    public void Plan_SkipsInputsNotYetPostedToEmonCms()
    {
        var data = OnePdu("o0", "Server A", ("realpower", "60"));
        var config = WithFeeds("realpower");

        var plan = EmonCmsFeedPlanner.Plan(data, config, Array.Empty<EmonInput>(), Array.Empty<EmonFeed>());

        Assert.Empty(plan.Creates);
        Assert.Empty(plan.Links);
    }

    [Theory]
    [InlineData("1:42", 42)]
    [InlineData("1:42,5:9", 42)]
    [InlineData("5:9,1:42", 42)]
    [InlineData("5:9", null)]
    [InlineData("", null)]
    public void LinkedFeedId_FindsTheLogToFeedTarget(string processList, int? expected)
        => Assert.Equal(expected, EmonCmsFeedPlanner.LinkedFeedId(processList));

    [Fact]
    public void WithLogToFeed_AppendsWithoutDroppingExistingProcesses()
    {
        Assert.Equal("1:9", EmonCmsFeedPlanner.WithLogToFeed("", 9));
        Assert.Equal("5:3,1:9", EmonCmsFeedPlanner.WithLogToFeed("5:3", 9));
    }
}
