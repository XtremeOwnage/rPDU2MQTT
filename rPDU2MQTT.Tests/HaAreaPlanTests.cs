using rPDU2MQTT.Plugin.Locations;
using rPDU2MQTT.Core.HomeAssistant;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>Rooms published to Home Assistant as areas (#467): created, matched by name or renamed, previewed first.</summary>
public class HaAreaPlanTests
{
    private static readonly HaArea[] Areas = [new("kitchen", "Kitchen"), new("den_2", "Den"), new("attic", "Attic")];

    [Fact]
    public void EachRoom_IsCreated_MatchedByName_OrRenamedWhereLinked()
    {
        var plan = HaAreaPlan.Build(
            [new("kitchen", "kitchen", null), new("office", "Office", null), new("den", "Family Room", "den_2")],
            Areas, [], new Dictionary<string, string>());

        Assert.Equal(HaAreaPlan.Link, plan.Rooms[0].Action);
        Assert.Equal("kitchen", plan.Rooms[0].AreaId);
        Assert.Equal(HaAreaPlan.Create, plan.Rooms[1].Action);
        Assert.Equal(HaAreaPlan.Rename, plan.Rooms[2].Action);
        Assert.Equal("den_2", plan.Rooms[2].AreaId);
        // An area no room claims is left alone, and said to be.
        Assert.Equal("attic", Assert.Single(plan.LeftAlone).AreaId);
    }

    [Fact]
    public void ALinkedAreaDeletedInHomeAssistant_IsMadeAgain()
    {
        var plan = HaAreaPlan.Build([new("office", "Office", "gone")], Areas, [], new Dictionary<string, string>());

        Assert.Equal(HaAreaPlan.Create, plan.Rooms[0].Action);
        Assert.Contains("no longer exists", plan.Rooms[0].Why);
    }

    [Fact]
    public void ADevice_IsPutInItsRoom_UnlessSomeoneAlreadyPutItSomewhere()
    {
        var devices = new HaRegistryDevice[]
        {
            new("d1", "Fridge plug", ["energyflow_fridge"], null),
            new("d2", "Rack outlet", ["rack_outlet_1"], "attic"),
            new("d3", "Kettle", ["energyflow_kettle"], "kitchen"),
            new("d4", "Someone else's", ["zigbee_123"], null),
        };
        var rooms = new Dictionary<string, string> { ["energyflow_fridge"] = "kitchen", ["rack_outlet_1"] = "kitchen", ["energyflow_kettle"] = "kitchen" };

        var plan = HaAreaPlan.Build([new("kitchen", "Kitchen", null)], Areas, devices, rooms);

        Assert.Equal(HaAreaPlan.Set, plan.Devices.Single(d => d.DeviceId == "d1").Action);
        var kept = plan.Devices.Single(d => d.DeviceId == "d2");
        Assert.Equal(HaAreaPlan.Keep, kept.Action);
        Assert.Equal("Attic", kept.CurrentArea);
        Assert.Equal(HaAreaPlan.Ok, plan.Devices.Single(d => d.DeviceId == "d3").Action);
        Assert.DoesNotContain(plan.Devices, d => d.DeviceId == "d4");
    }

    private static readonly Dictionary<string, string> NoDevices = new();

    [Theory]
    [InlineData(HaSyncMode.Create, HaAreaPlan.Create, HaAreaPlan.Rename)]
    [InlineData(HaSyncMode.Update, HaAreaPlan.Skip, HaAreaPlan.Rename)]
    [InlineData(HaSyncMode.Off, HaAreaPlan.Skip, HaAreaPlan.Ok)]
    public void TheAreasMode_DecidesWhatIsCreatedOrRenamed(string mode, string missing, string linked)
    {
        var plan = HaAreaPlan.Build([new("office", "Office", null), new("den", "Family Room", "den_2"), new("kitchen", "Kitchen", null)],
            Areas, [], NoDevices, new HaSyncConfig { Areas = mode });

        Assert.Equal(missing, plan.Rooms[0].Action);
        Assert.Equal(linked, plan.Rooms[1].Action);
        Assert.Equal(HaAreaPlan.Link, plan.Rooms[2].Action);
    }

    [Fact]
    public void DeviceAreasOff_LeavesDevicesAlone()
    {
        var plan = HaAreaPlan.Build([new("kitchen", "Kitchen", null)], Areas, [new("d1", "Fridge", ["f"], null)],
            new Dictionary<string, string> { ["f"] = "kitchen" }, new HaSyncConfig { DeviceAreas = HaSyncMode.Off });

        Assert.Empty(plan.Devices);
    }

    [Fact]
    public void Floors_AreCreatedOrMatched_AndEachAreaGetsItsFloor()
    {
        var plan = HaAreaPlan.Build([new("kitchen", "Kitchen", null, "ground"), new("loft", "Loft", null, "upper")],
            Areas, [], NoDevices, new HaSyncConfig { Floors = HaSyncMode.Create },
            [new("ground", "Ground", 0, null), new("upper", "Upstairs", 1, null)], [new("first", "Ground", 0)]);

        Assert.Equal(HaAreaPlan.Link, plan.Floors[0].Action);
        Assert.Equal(HaAreaPlan.Create, plan.Floors[1].Action);
        var kitchen = plan.Fields.Single(f => f.Room == "kitchen" && f.Field == "floor");
        Assert.Equal(HaAreaPlan.Set, kitchen.Action);
        Assert.Equal("first", kitchen.Value);
        Assert.Equal(HaAreaPlan.Set, plan.Fields.Single(f => f.Room == "loft").Action);
    }

    [Fact]
    public void FloorsOff_PlansNoFloors()
    {
        var plan = HaAreaPlan.Build([new("kitchen", "Kitchen", null, "ground")], Areas, [], NoDevices, new HaSyncConfig(),
            [new("ground", "Ground", 0, null)], []);

        Assert.Empty(plan.Floors);
        Assert.Empty(plan.Fields);
    }

    [Theory]
    [InlineData(HaSyncMode.Fill, HaAreaPlan.Keep)]
    [InlineData(HaSyncMode.Always, HaAreaPlan.Set)]
    public void AreaSensors_FillOnlyWhenUnset_OrAlways(string mode, string whenSet)
    {
        HaArea[] areas = [new("kitchen", "Kitchen", Temperature: "sensor.other"), new("den", "Den")];
        var plan = HaAreaPlan.Build([new("kitchen", "Kitchen", null, Temperature: "sensor.k"), new("den", "Den", null, Humidity: "sensor.d")],
            areas, [], NoDevices, new HaSyncConfig { AreaSensors = mode });

        Assert.Equal(whenSet, plan.Fields.Single(f => f.Room == "kitchen").Action);
        var den = plan.Fields.Single(f => f.Room == "den");
        Assert.Equal(("humidity", HaAreaPlan.Set, "sensor.d"), (den.Field, den.Action, den.Value));
    }
}
