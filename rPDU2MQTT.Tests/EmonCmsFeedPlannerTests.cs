using rPDU2MQTT.Classes;
using rPDU2MQTT.Integrations.EmonCms;
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

    /// <summary>
    /// Switch a type on, with any of its defaults overridden. The list is fixed and always complete, so a
    /// test says which types it wants by enabling them, not by building a list of its own.
    /// </summary>
    private static EmonCmsFeedTypeConfig Enable(Config c, string type, int? interval = null, EmonCmsFeedEngine? engine = null)
    {
        var t = c.EmonCMS.Feeds.Types.Single(x => string.Equals(x.Type, type, StringComparison.OrdinalIgnoreCase));
        t.Enabled = true;
        if (interval is { } i) t.IntervalSeconds = i;
        if (engine is { } e) t.Engine = e;
        return t;
    }

    private static Config Base()
    {
        var c = new Config();
        c.EmonCMS.Node = "rpdu2mqtt";
        c.EmonCMS.InputNameTemplate = "{device}_{source}_{type}";
        c.EmonCMS.Feeds.AutoConfigure = true;
        c.EmonCMS.Feeds.StorageNameTemplate = "{device}_{source}_{type}";
        c.EmonCMS.Feeds.Virtual.NameTemplate = "{name} {type}";
        // Nothing on by default here: each test enables the types it is about.
        foreach (var t in c.EmonCMS.Feeds.Types) t.Enabled = false;
        return c;
    }

    [Fact]
    public void BuildDesired_IdempotentStorageFeeds_ForConfiguredTypesOnly()
    {
        var data = OnePdu("o0", "Server A", ("realpower", "60"), ("energy", "12"), ("voltage", "230"));
        var config = Base();
        Enable(config, "realpower", 10);
        Enable(config, "energy", 10);

        var d = EmonCmsFeedPlanner.BuildDesired(data, config);

        // Stable, display-name-free storage names; voltage excluded.
        Assert.Equal(2, d.Feeds.Count);
        Assert.Contains(d.Feeds, x => x.Name == "rack_pdu_1_o0_realpower" && x.DataType == 1 && x.IntervalSeconds == 10);
        Assert.Contains(d.Feeds, x => x.Name == "rack_pdu_1_o0_energy");
        Assert.DoesNotContain(d.Feeds, x => x.Name.Contains("voltage"));
        Assert.Equal(2, d.Inputs.Count);
        Assert.All(d.Inputs, i => Assert.Single(i.Steps));   // log to feed, and nothing derived
        Assert.Empty(d.Virtuals);
    }

    [Fact]
    public void BuildDesired_TypeEngineInheritsFeedsDefault_ButIntervalIsAlwaysTheTypesOwn()
    {
        var data = OnePdu("o0", "Server A", ("realpower", "60"), ("energy", "12"));
        var config = Base();
        config.EmonCMS.Feeds.Engine = EmonCmsFeedEngine.MySQL;          // Feeds-level default
        config.EmonCMS.Feeds.IntervalSeconds = 20;                      // no longer inherited by a type
        Enable(config, "realpower");   // inherits MySQL, keeps its own 10s
        Enable(config, "energy", 5, EmonCmsFeedEngine.PHPFina);

        var d = EmonCmsFeedPlanner.BuildDesired(data, config);

        var rp = d.Feeds.Single(x => x.Name.EndsWith("realpower"));
        Assert.Equal((int)EmonCmsFeedEngine.MySQL, rp.Engine);
        Assert.Equal(10, rp.IntervalSeconds);
        var en = d.Feeds.Single(x => x.Name.EndsWith("energy"));
        Assert.Equal((int)EmonCmsFeedEngine.PHPFina, en.Engine);
        Assert.Equal(5, en.IntervalSeconds);
    }

    [Fact]
    public void BuildDesired_DailyEnergy_IsATypeOfItsOwn_DerivedFromTheEnergyCounter()
    {
        var data = OnePdu("o0", "Server A", ("energy", "12"));
        var config = Base();
        Enable(config, "energy", 10);
        Enable(config, "energy_d");

        var d = EmonCmsFeedPlanner.BuildDesired(data, config);

        Assert.Contains(d.Feeds, x => x.Name == "rack_pdu_1_o0_energy" && x.DataType == 1 && x.IntervalSeconds == 10);
        var daily = Assert.Single(d.Feeds, x => x.DataType == 2);
        Assert.Equal("rack_pdu_1_o0_energy_d", daily.Name);
        Assert.Equal(86400, daily.IntervalSeconds);

        var steps = Assert.Single(d.Inputs).Steps;
        Assert.Equal(ProcessSlot.KwhAccumulator, steps[0].Process);
        Assert.Equal(ProcessSlot.KwhToKwhd, steps[1].Process);
        Assert.Equal("rack_pdu_1_o0_energy_d", steps[1].Feed);
    }

    /// <summary>A type switched off is not provisioned, and nothing derives it either.</summary>
    [Fact]
    public void BuildDesired_ADisabledType_GetsNoFeedAndNoStep()
    {
        var data = OnePdu("o0", "Server A", ("energy", "12"));
        var config = Base();
        Enable(config, "energy", 10);
        config.EmonCMS.Feeds.Types.Single(t => t.Type == "energy_d").Enabled = false;

        var d = EmonCmsFeedPlanner.BuildDesired(data, config);

        Assert.DoesNotContain(d.Feeds, x => x.Name.EndsWith("_energy_d"));
        Assert.DoesNotContain(Assert.Single(d.Inputs).Steps, x => x.Process == ProcessSlot.KwhToKwhd);
    }

    /// <summary>
    /// Forcing the counter local decides how the counter is written, not what may be read from it: the
    /// daily total is still EmonCMS's to work out, because it is the day boundary that is being deferred.
    /// </summary>
    [Fact]
    public void BuildDesired_ForcingTheCounterLocal_StillLetsEmonCmsDeriveTheDailyTotal()
    {
        var data = OnePdu("o0", "Server A", ("energy", "12"));
        var config = Base();
        var energy = Enable(config, "energy", 10);
        energy.Calculation = EmonCmsCalculation.ForceLocal;
        Enable(config, "energy_d");

        var steps = Assert.Single(EmonCmsFeedPlanner.BuildDesired(data, config).Inputs).Steps;

        Assert.Equal(ProcessSlot.LogToFeed, steps[0].Process);
        Assert.Contains(steps, x => x.Process == ProcessSlot.KwhToKwhd);
    }

    /// <summary>The suffix is where the type appears in a feed name, and it is the operator's to choose.</summary>
    [Fact]
    public void BuildDesired_TheTypeSuffix_NamesTheFeed()
    {
        var data = OnePdu("o0", "Server A", ("realpower", "60"));
        var config = Base();
        var power = Enable(config, "realpower");
        power.Prefix = "site_";
        power.Suffix = "_bananas";

        var d = EmonCmsFeedPlanner.BuildDesired(data, config);

        Assert.Contains(d.Feeds, x => x.Name == "site_rack_pdu_1_o0_bananas");
    }

    [Fact]
    public void BuildDesired_VirtualFeeds_UseFriendlyNamesSourcedFromStorageFeeds()
    {
        var data = OnePdu("o0", "Server A", ("realpower", "60"));
        var config = Base();
        Enable(config, "realpower");
        config.EmonCMS.Feeds.Virtual.Enabled = true;

        var d = EmonCmsFeedPlanner.BuildDesired(data, config);

        var v = Assert.Single(d.Virtuals);
        Assert.Equal("Server A realpower", v.Name);
        Assert.Equal("rack_pdu_1_o0_realpower", v.SourceFeed);
    }

    /// <summary>The template alone decides whether a feed name is stable or follows the display name.</summary>
    [Fact]
    public void BuildDesired_ADisplayNameTemplate_NamesStorageFeedsFromIt_AndSkipsRedundantVirtuals()
    {
        var data = OnePdu("o0", "Server A", ("realpower", "60"));
        var config = Base();
        config.EmonCMS.Feeds.StorageNameTemplate = "{name}";
        var power = Enable(config, "realpower");
        power.Suffix = " {type}";                     // the same name the virtual template produces
        config.EmonCMS.Feeds.Virtual.Enabled = true;  // would collide with the (now friendly) storage name

        var d = EmonCmsFeedPlanner.BuildDesired(data, config);

        Assert.Contains(d.Feeds, x => x.Name == "Server A realpower");
        Assert.Empty(d.Virtuals);   // friendly == storage, so no separate virtual feed
    }

    private static readonly Func<string, int?> Feeds =
        name => name switch { "store" => 16, "daily" => 17, "power" => 18, _ => null };

    [Fact]
    public void BuildInputProcessList_WritesEachStepInOrder()
    {
        // EmonCMS stores the processlist as <process>:<feedid>, and the numbered built-ins sit alongside
        // module-provided processes keyed by name — which is why an id is text here, not an int.
        Assert.Equal("process__log_to_feed:16", EmonCmsFeedPlanner.BuildInputProcessList(
            new DesiredProcess[] { new(ProcessSlot.LogToFeed, "store") }, Feeds));

        Assert.Equal("process__log_to_feed:16,process__kwh_to_kwhd:17", EmonCmsFeedPlanner.BuildInputProcessList(
            new DesiredProcess[] { new(ProcessSlot.LogToFeed, "store"), new(ProcessSlot.KwhToKwhd, "daily") }, Feeds));

        // kWh to Power rewrites the value it passes on, so it is written last and nothing follows it.
        Assert.Equal("process__kwh_accumulator:16,process__kwh_to_kwhd:17,process__kwh_to_power:18",
            EmonCmsFeedPlanner.BuildInputProcessList(
                new DesiredProcess[]
                {
                    new(ProcessSlot.KwhAccumulator, "store"),
                    new(ProcessSlot.KwhToKwhd, "daily"),
                    new(ProcessSlot.KwhToPower, "power"),
                }, Feeds));
    }

    /// <summary>
    /// A step whose feed does not exist is left out rather than written as a broken pair — EmonCMS accepts
    /// one and then logs nothing, with no error to read.
    /// </summary>
    [Fact]
    public void BuildInputProcessList_DropsAStepItCannotResolve()
    {
        Assert.Equal("process__log_to_feed:16", EmonCmsFeedPlanner.BuildInputProcessList(
            new DesiredProcess[] { new(ProcessSlot.LogToFeed, "store"), new(ProcessSlot.PowerToKwh, "absent") }, Feeds));
    }

    [Theory]
    [InlineData("1:42", "1", 42)]
    [InlineData("1:42,23:9", "1", 42)]
    [InlineData("34:9", "1", null)]
    [InlineData("", "1", null)]
    public void LinkedFeedId_FindsTheLogToFeedTarget(string processList, string logProc, int? expected)
        => Assert.Equal(expected, EmonCmsFeedPlanner.LinkedFeedId(processList, logProc));

    /// <summary>
    /// A config written before the type carried its own suffix names its feeds with {type} in the template.
    /// That placeholder is dropped and the suffix supplies it, so the names it already provisioned — and the
    /// history behind them — stay exactly as they were.
    /// </summary>
    [Fact]
    public void BuildDesired_ATemplateStillNamingTheType_ProducesTheSameNamesAsBefore()
    {
        var data = OnePdu("o0", "Server A", ("realpower", "60"), ("energy", "12"));
        var config = Base();
        config.EmonCMS.Feeds.StorageNameTemplate = "{device}_{source}_{type}";   // the pre-#436 default
        Enable(config, "realpower");
        Enable(config, "energy");

        var d = EmonCmsFeedPlanner.BuildDesired(data, config);

        Assert.Contains(d.Feeds, x => x.Name == "rack_pdu_1_o0_realpower");
        Assert.Contains(d.Feeds, x => x.Name == "rack_pdu_1_o0_energy");
        Assert.DoesNotContain(d.Feeds, x => x.Name.Contains("realpower_realpower") || x.Name.Contains("energy_energy"));
    }


    /// <summary>
    /// An outlet reports power and energy, not frequency. Enabling a type is permission to record it where
    /// the device sends one, never to provision a feed nothing will write to — the planner only ever walks
    /// the readings that arrived.
    /// </summary>
    [Fact]
    public void BuildDesired_AnEnabledType_ProvisionsNothingForAReadingTheDeviceDoesNotSend()
    {
        var data = OnePdu("o0", "Server A", ("realpower", "60"), ("energy", "12"));
        var config = Base();
        Enable(config, "realpower");
        Enable(config, "energy");
        Enable(config, "frequency");
        Enable(config, "voltage");

        var d = EmonCmsFeedPlanner.BuildDesired(data, config);

        Assert.DoesNotContain(d.Feeds, x => x.Name.Contains("frequency") || x.Name.Contains("voltage"));
        Assert.DoesNotContain(d.Inputs, x => x.InputName.Contains("frequency") || x.InputName.Contains("voltage"));
        Assert.Contains(d.Feeds, x => x.Name == "rack_pdu_1_o0_realpower");
    }

    /// <summary>Prefer local keeps this bridge's counter as it arrives, rather than accumulating it.</summary>
    [Fact]
    public void BuildDesired_PreferLocal_LogsTheCounterItWasSent()
    {
        var data = OnePdu("o0", "Server A", ("energy", "12"));
        var config = Base();
        Enable(config, "energy", 10).Calculation = EmonCmsCalculation.PreferLocal;

        var steps = Assert.Single(EmonCmsFeedPlanner.BuildDesired(data, config).Inputs).Steps;

        Assert.Equal(ProcessSlot.LogToFeed, steps[0].Process);
    }

    /// <summary>Prefer EmonCMS hands the same counter to the accumulator instead.</summary>
    [Fact]
    public void BuildDesired_PreferEmonCms_AccumulatesTheCounterInstead()
    {
        var data = OnePdu("o0", "Server A", ("energy", "12"));
        var config = Base();
        Enable(config, "energy", 10).Calculation = EmonCmsCalculation.PreferEmonCms;

        var steps = Assert.Single(EmonCmsFeedPlanner.BuildDesired(data, config).Inputs).Steps;

        Assert.Equal(ProcessSlot.KwhAccumulator, steps[0].Process);
    }

    /// <summary>Forced local on a type the device does not send leaves the feed unwritten rather than derived.</summary>
    [Fact]
    public void BuildDesired_ForceLocal_DerivesNothingForAReadingThatNeverArrives()
    {
        var data = OnePdu("o0", "Server A", ("realpower", "60"));
        var config = Base();
        Enable(config, "realpower");
        Enable(config, "energy").Calculation = EmonCmsCalculation.ForceLocal;

        var d = EmonCmsFeedPlanner.BuildDesired(data, config);

        Assert.DoesNotContain(d.Inputs.SelectMany(i => i.Steps), x => x.Process == ProcessSlot.PowerToKwh);
    }

    /// <summary>
    /// Forcing EmonCMS on power leaves a watts-only outlet with no power feed at all: kWh to Power is the
    /// only process that produces watts, and it needs an energy counter this outlet does not have. The day
    /// boundary that makes forcing EmonCMS right for the daily total does not apply to a reading.
    /// </summary>
    [Fact]
    public void BuildDesired_ForceEmonCmsOnPower_LeavesAWattsOnlyOutletWithNoPowerFeed()
    {
        var data = OnePdu("o0", "Server A", ("realpower", "60"));
        var config = Base();
        Enable(config, "realpower").Calculation = EmonCmsCalculation.ForceEmonCms;

        var d = EmonCmsFeedPlanner.BuildDesired(data, config);

        Assert.DoesNotContain(d.Inputs.SelectMany(i => i.Steps), x => x.Feed.EndsWith("_realpower"));
    }

    /// <summary>The daily total ships forced to EmonCMS, which owns the day boundary this bridge's clock does not.</summary>
    [Fact]
    public void BuildDesired_TheDailyTotal_IsForcedToEmonCmsByDefault()
    {
        Assert.Equal(EmonCmsCalculation.ForceEmonCms, EmonCmsFeedTypeConfig.For("energy_d").Calculation);

        var data = OnePdu("o0", "Server A", ("energy", "12"));
        var config = Base();
        Enable(config, "energy");
        Enable(config, "energy_d");

        var steps = Assert.Single(EmonCmsFeedPlanner.BuildDesired(data, config).Inputs).Steps;

        Assert.Contains(steps, x => x.Process == ProcessSlot.KwhToKwhd && x.Feed == "rack_pdu_1_o0_energy_d");
    }
}
