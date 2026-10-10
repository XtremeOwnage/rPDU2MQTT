using rPDU2MQTT.Classes;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Models.PDU;
using rPDU2MQTT.Plugin.EmonCms;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>The feed planner's calculation switches (#441): each one adds or removes exactly its step.</summary>
public class EmonCmsCalculationsTests
{
    private static PduData Outlet(params (string type, string val)[] measurements)
    {
        var outlet = new Outlet { Key = 0, Entity_Name = "o0", Entity_DisplayName = "Server A" };
        foreach (var (type, val) in measurements)
            outlet.Measurements.Add(new Measurement { Type = type, Value = val, Units = "" });
        var device = new Device { Key = "pdu1", Entity_Name = "pdu", Entity_DisplayName = "PDU" };
        device.Outlets.Add(outlet);
        var data = new PduData();
        data.Devices.Add(device);
        return data;
    }

    private static Config Base(params string[] types)
    {
        var c = new Config();
        c.EmonCMS.Node = "rpdu2mqtt";
        c.EmonCMS.InputNameTemplate = "{device}_{source}_{type}";
        c.EmonCMS.Feeds.StorageNameTemplate = "{device}_{source}";   // each type appends its own suffix
        foreach (var t in c.EmonCMS.Feeds.Types) t.Enabled = types.Contains(t.Type, StringComparer.OrdinalIgnoreCase);
        return c;
    }

    private static IReadOnlyList<DesiredProcess> StepsOf(EmonDesiredState d, string input)
        => d.Inputs.Single(i => i.InputName == input).Steps;

    [Fact]
    public void TheDefaults_AreTheWorkingSetFromBefore()
    {
        var calc = new EmonCmsCalculationsConfig();
        Assert.True(calc.EnergyFromPower && calc.DailyFromPower && calc.DailyFromEnergy && calc.PowerFromEnergy);
        Assert.False(calc.PowerFromVoltageAndCurrent || calc.VoltageFromPowerAndCurrent || calc.CurrentFromPowerAndVoltage);
    }

    [Fact]
    public void PowerOnly_DerivesEnergyAndDaily_UntilEachIsSwitchedOff()
    {
        var data = Outlet(("realpower", "60"));
        var config = Base("realpower", "energy", "energy_d");

        var steps = StepsOf(EmonCmsFeedPlanner.BuildDesired(data, config), "pdu_o0_realpower").Select(s => s.Process).ToList();
        Assert.Equal([ProcessSlot.LogToFeed, ProcessSlot.PowerToKwh, ProcessSlot.PowerToKwhd], steps);

        config.EmonCMS.Feeds.Calculations.EnergyFromPower = false;
        steps = StepsOf(EmonCmsFeedPlanner.BuildDesired(data, config), "pdu_o0_realpower").Select(s => s.Process).ToList();
        Assert.Equal([ProcessSlot.LogToFeed, ProcessSlot.PowerToKwhd], steps);

        config.EmonCMS.Feeds.Calculations.DailyFromPower = false;
        var d = EmonCmsFeedPlanner.BuildDesired(data, config);
        Assert.Equal([ProcessSlot.LogToFeed], StepsOf(d, "pdu_o0_realpower").Select(s => s.Process));
        Assert.DoesNotContain(d.Feeds, f => f.Name.EndsWith("energy_d"));
    }

    [Fact]
    public void EnergyOnly_DerivesPowerAndDaily_UntilEachIsSwitchedOff()
    {
        var data = Outlet(("energy", "12"));
        var config = Base("realpower", "energy", "energy_d");

        Assert.Equal([ProcessSlot.LogToFeed, ProcessSlot.KwhToKwhd, ProcessSlot.KwhToPower],
            StepsOf(EmonCmsFeedPlanner.BuildDesired(data, config), "pdu_o0_energy").Select(s => s.Process));

        config.EmonCMS.Feeds.Calculations.PowerFromEnergy = false;
        config.EmonCMS.Feeds.Calculations.DailyFromEnergy = false;
        Assert.Equal([ProcessSlot.LogToFeed],
            StepsOf(EmonCmsFeedPlanner.BuildDesired(data, config), "pdu_o0_energy").Select(s => s.Process));
    }

    [Fact]
    public void PowerFromVoltageAndCurrent_MultipliesOnTheCurrentInput_AfterItsOwnLog()
    {
        var data = Outlet(("current", "0.5"), ("voltage", "240"));
        var config = Base("realpower", "current", "voltage");

        Assert.Single(StepsOf(EmonCmsFeedPlanner.BuildDesired(data, config), "pdu_o0_current"));

        config.EmonCMS.Feeds.Calculations.PowerFromVoltageAndCurrent = true;
        var steps = StepsOf(EmonCmsFeedPlanner.BuildDesired(data, config), "pdu_o0_current");
        Assert.Equal(new DesiredProcess[]
        {
            new(ProcessSlot.LogToFeed, "pdu_o0_current"),
            new(ProcessSlot.TimesInput, "pdu_o0_voltage", InputArg: true),
            new(ProcessSlot.LogToFeed, "pdu_o0_realpower"),
        }, steps);
    }

    [Fact]
    public void PowerFromVoltageAndCurrent_StandsAside_ForAReadingOrAnEnergyCounter()
    {
        var config = Base("realpower", "current", "voltage", "energy");
        config.EmonCMS.Feeds.Calculations.PowerFromVoltageAndCurrent = true;

        Assert.Single(StepsOf(EmonCmsFeedPlanner.BuildDesired(Outlet(("current", "0.5"), ("voltage", "240"), ("realpower", "120")), config), "pdu_o0_current"));
        Assert.Single(StepsOf(EmonCmsFeedPlanner.BuildDesired(Outlet(("current", "0.5"), ("voltage", "240"), ("energy", "3")), config), "pdu_o0_current"));
    }

    [Fact]
    public void VoltageAndCurrent_AreDividedOutOfPower_Last()
    {
        var config = Base("realpower", "current", "voltage", "energy");
        config.EmonCMS.Feeds.Calculations.VoltageFromPowerAndCurrent = true;
        config.EmonCMS.Feeds.Calculations.CurrentFromPowerAndVoltage = true;

        var volts = StepsOf(EmonCmsFeedPlanner.BuildDesired(Outlet(("realpower", "120"), ("current", "0.5")), config), "pdu_o0_realpower");
        Assert.Equal(new DesiredProcess(ProcessSlot.DivideInput, "pdu_o0_current", InputArg: true), volts[^2]);
        Assert.Equal(new DesiredProcess(ProcessSlot.LogToFeed, "pdu_o0_voltage"), volts[^1]);
        // Power to kWh needs watts, so it runs before the division rewrites them.
        Assert.True(volts.ToList().FindIndex(s => s.Process == ProcessSlot.PowerToKwh) < volts.Count - 2);

        var amps = StepsOf(EmonCmsFeedPlanner.BuildDesired(Outlet(("realpower", "120"), ("voltage", "240")), config), "pdu_o0_realpower");
        Assert.Equal(new DesiredProcess(ProcessSlot.DivideInput, "pdu_o0_voltage", InputArg: true), amps[^2]);
        Assert.Equal(new DesiredProcess(ProcessSlot.LogToFeed, "pdu_o0_current"), amps[^1]);
    }

    [Fact]
    public void AForceLocalType_IsNeverCalculated()
    {
        var config = Base("realpower", "current", "voltage");
        config.EmonCMS.Feeds.Calculations.PowerFromVoltageAndCurrent = true;
        config.EmonCMS.Feeds.Types.Single(t => t.Type == "realpower").Calculation = EmonCmsCalculation.ForceLocal;

        Assert.Single(StepsOf(EmonCmsFeedPlanner.BuildDesired(Outlet(("current", "0.5"), ("voltage", "240")), config), "pdu_o0_current"));
    }

    [Fact]
    public void AnInputArg_ResolvesToTheInputId_AndAMissingInputEndsTheList()
    {
        DesiredProcess[] steps =
        [
            new(ProcessSlot.LogToFeed, "amps"),
            new(ProcessSlot.TimesInput, "volts", InputArg: true),
            new(ProcessSlot.LogToFeed, "watts"),
        ];
        Func<string, int?> feeds = n => n switch { "amps" => 1, "watts" => 2, _ => null };

        Assert.Equal("process__log_to_feed:1,process__times_input:7,process__log_to_feed:2",
            EmonCmsFeedPlanner.BuildInputProcessList(steps, feeds, n => n == "volts" ? 7 : null));
        // Without the voltage input the product cannot be formed, and logging amps as watts would be wrong.
        Assert.Equal("process__log_to_feed:1", EmonCmsFeedPlanner.BuildInputProcessList(steps, feeds, _ => null));
    }
}
