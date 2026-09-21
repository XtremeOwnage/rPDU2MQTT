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
}
