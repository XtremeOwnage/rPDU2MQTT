using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Models.Config;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>Room and area tags turned into locations (#461), planned and shown before anything is written.</summary>
public class LocationMigrationTests
{
    private static EnergyFlowConfig Tagged() => new()
    {
        Sites = { new SiteConfig { Id = "home", Floors = { new FloorConfig { Id = "ground", Rooms = { new RoomConfig { Id = "office" } } } } } },
        Nodes =
        {
            new EnergyFlowNode { Id = "fridge", Tags = { "kitchen", "critical" } },
            new EnergyFlowNode { Id = "b06", Tags = { "kitchen", "garage" } },
            new EnergyFlowNode { Id = "desk", Tags = { "office" } },
            new EnergyFlowNode { Id = "placed", Tags = { "garage" }, Location = "office" },
        },
        AutoTags = { new AutoTagRule { Match = "outlet:rack:*", Tags = { "office" } } },
    };

    [Theory]
    [InlineData("kitchen", "room")]
    [InlineData("master_bedroom", "room")]
    [InlineData("Upstairs", "area")]
    [InlineData("critical", "skip")]
    [InlineData("rack-1", "skip")]
    public void ATagIsSuggestedAsWhatItReadsLike(string tag, string expected) => Assert.Equal(expected, LocationMigration.Suggest(tag));

    [Fact]
    public void ThePlan_CreatesPlaces_PlacesNodes_AndSaysWhatItLeftAlone()
    {
        var plan = LocationMigration.Plan(Tagged(),
        [
            new TagMapping { Tag = "kitchen", As = "room", Floor = "ground" },
            new TagMapping { Tag = "garage", As = "room", Floor = "ground", RemoveTag = true },
            new TagMapping { Tag = "office", As = "room", Floor = "ground" },
            new TagMapping { Tag = "critical", As = "skip" },
        ]);

        Assert.Equal(["kitchen", "garage"], plan.Creates.Select(c => c.Id));
        Assert.Equal("Kitchen", plan.Creates[0].Name);
        Assert.Equal("kitchen", plan.Nodes.Single(n => n.Node == "fridge").Location);
        // Tagged with two rooms: the floor holding both, and it says so.
        var b06 = plan.Nodes.Single(n => n.Node == "b06");
        Assert.Equal("ground", b06.Location);
        Assert.NotNull(b06.Note);
        // An existing room is reused rather than made twice.
        Assert.Equal("office", plan.Nodes.Single(n => n.Node == "desk").Location);
        Assert.Contains(plan.Skipped, s => s.What == "room 'office'");
        // A node already placed is not moved.
        Assert.DoesNotContain(plan.Nodes, n => n.Node == "placed");
        Assert.Contains(plan.Skipped, s => s.What == "node 'placed'");
        Assert.Equal(new MigrationRule("outlet:rack:*", "office", "office"), Assert.Single(plan.Rules));
        Assert.Equal(["garage"], plan.RemoveTags);
    }

    [Fact]
    public void ANewPlaceNeedsAFloor()
    {
        var plan = LocationMigration.Plan(Tagged(), [new TagMapping { Tag = "kitchen", As = "room" }]);

        Assert.Empty(plan.Creates);
        Assert.Empty(plan.Nodes);
        Assert.Contains(plan.Skipped, s => s.Why.Contains("No floor"));
    }
}
