using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.EmonCms;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Models.PDU;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>EmonCmsFeedPlanner: the desired EmonCMS feed/processlist/virtual-feed set from readings + config (#163).</summary>
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

    private static Config Base()
    {
        var c = new Config();
        c.EmonCMS.Node = "rpdu2mqtt";
        c.EmonCMS.InputNameTemplate = "{device}_{source}_{type}";
        c.EmonCMS.Feeds.AutoConfigure = true;
        c.EmonCMS.Feeds.StorageNameTemplate = "{device}_{source}_{type}";
        c.EmonCMS.Feeds.Virtual.NameTemplate = "{name} {type}";
        c.EmonCMS.Feeds.Types = new();
        return c;
    }

    [Fact]
    public void BuildDesired_IdempotentStorageFeeds_ForConfiguredTypesOnly()
    {
        var data = OnePdu("o0", "Server A", ("realpower", "60"), ("energy", "12"), ("voltage", "230"));
        var config = Base();
        config.EmonCMS.Feeds.Types.Add(new() { Type = "realpower", IntervalSeconds = 10 });
        config.EmonCMS.Feeds.Types.Add(new() { Type = "energy", IntervalSeconds = 10 });

        var d = EmonCmsFeedPlanner.BuildDesired(data, config);

        // Stable, display-name-free storage names; voltage excluded.
        Assert.Equal(2, d.Feeds.Count);
        Assert.Contains(d.Feeds, x => x.Name == "rack_pdu_1_o0_realpower" && x.DataType == 1 && x.IntervalSeconds == 10);
        Assert.Contains(d.Feeds, x => x.Name == "rack_pdu_1_o0_energy");
        Assert.DoesNotContain(d.Feeds, x => x.Name.Contains("voltage"));
        Assert.Equal(2, d.Inputs.Count);
        Assert.All(d.Inputs, i => Assert.Null(i.DailyFeed));
        Assert.Empty(d.Virtuals);
    }

    [Fact]
    public void BuildDesired_DailyEnergy_AddsADailyFeedAtItsOwnInterval()
    {
        var data = OnePdu("o0", "Server A", ("energy", "12"));
        var config = Base();
        config.EmonCMS.Feeds.Types.Add(new() { Type = "energy", IntervalSeconds = 10, Daily = true, DailyIntervalSeconds = 86400 });

        var d = EmonCmsFeedPlanner.BuildDesired(data, config);

        Assert.Contains(d.Feeds, x => x.Name == "rack_pdu_1_o0_energy" && x.DataType == 1 && x.IntervalSeconds == 10);
        var daily = Assert.Single(d.Feeds.Where(x => x.DataType == 2));
        Assert.Equal("rack_pdu_1_o0_energy_d", daily.Name);
        Assert.Equal(86400, daily.IntervalSeconds);
        Assert.Equal("rack_pdu_1_o0_energy_d", Assert.Single(d.Inputs).DailyFeed);
    }

    [Fact]
    public void BuildDesired_VirtualFeeds_UseFriendlyNamesSourcedFromStorageFeeds()
    {
        var data = OnePdu("o0", "Server A", ("realpower", "60"));
        var config = Base();
        config.EmonCMS.Feeds.Types.Add(new() { Type = "realpower" });
        config.EmonCMS.Feeds.Virtual.Enabled = true;

        var d = EmonCmsFeedPlanner.BuildDesired(data, config);

        var v = Assert.Single(d.Virtuals);
        Assert.Equal("Server A realpower", v.Name);
        Assert.Equal("rack_pdu_1_o0_realpower", v.SourceFeed);
    }

    [Fact]
    public void BuildDesired_NonIdempotent_NamesStorageFeedsFromDisplayName_AndSkipsRedundantVirtuals()
    {
        var data = OnePdu("o0", "Server A", ("realpower", "60"));
        var config = Base();
        config.EmonCMS.Feeds.IdempotentNames = false;
        config.EmonCMS.Feeds.Types.Add(new() { Type = "realpower" });
        config.EmonCMS.Feeds.Virtual.Enabled = true;   // would collide with the (now friendly) storage name

        var d = EmonCmsFeedPlanner.BuildDesired(data, config);

        Assert.Contains(d.Feeds, x => x.Name == "Server A realpower");
        Assert.Empty(d.Virtuals);   // friendly == storage, so no separate virtual feed
    }

    [Fact]
    public void BuildInputProcessList_LogToFeed_ThenDailyStepWhenConfigured()
    {
        var p = new EmonProcessIds("1", "44", "sfeed");
        Assert.Equal("1:16", EmonCmsFeedPlanner.BuildInputProcessList(16, null, p));
        Assert.Equal("1:16,44:17", EmonCmsFeedPlanner.BuildInputProcessList(16, 17, p));
        // Daily wanted but no kwh_to_kwhd id -> only the log step.
        Assert.Equal("1:16", EmonCmsFeedPlanner.BuildInputProcessList(16, 17, new EmonProcessIds("1", null, null)));
    }

    [Theory]
    [InlineData("1:42", "1", 42)]
    [InlineData("1:42,44:9", "1", 42)]
    [InlineData("44:9", "1", null)]
    [InlineData("", "1", null)]
    public void LinkedFeedId_FindsTheLogToFeedTarget(string processList, string logProc, int? expected)
        => Assert.Equal(expected, EmonCmsFeedPlanner.LinkedFeedId(processList, logProc));
}
