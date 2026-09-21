using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Models.Config;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>The location model (#461): sites, floors, rooms and areas, where a node is, and energy rolled up the tree.</summary>
public class LocationModelTests
{
    private sealed class Fixed(Dictionary<string, double> v) : IFlowValueSource
    {
        public bool TryGetValue(string node, string metric, out double value) => v.TryGetValue(node + "|" + metric, out value);
    }

    /// <summary>A house: kitchen, office and garage downstairs with a "front" area over kitchen and office; a bedroom upstairs.</summary>
    private static EnergyFlowConfig House() => new()
    {
        Sites =
        {
            new SiteConfig
            {
                Id = "home", Name = "Home",
                Floors =
                {
                    new FloorConfig
                    {
                        Id = "ground", Name = "Ground", Level = 0,
                        Rooms = { new RoomConfig { Id = "kitchen", Name = "Kitchen" }, new RoomConfig { Id = "office", Name = "Office" }, new RoomConfig { Id = "garage", Name = "Garage" } },
                        Areas = { new AreaConfig { Id = "front", Name = "Front", Rooms = { "kitchen", "office" } } },
                    },
                    new FloorConfig { Id = "upstairs", Name = "Upstairs", Level = 1, Rooms = { new RoomConfig { Id = "bedroom", Name = "Bedroom" } } },
                },
            },
        },
    };

    private static Func<string, double?> Values(Dictionary<string, double?> v) => id => v.TryGetValue(id, out var x) ? x : null;

    [Fact]
    public void ARoomCountsTowardItsAreasFloorAndSite()
    {
        var index = LocationIndex.For(House());

        Assert.True(index.Containers("kitchen").SetEquals(["kitchen", "front", "ground", "home"]));
        Assert.True(index.Within("office", "front"));
        Assert.False(index.Within("garage", "front"));
        Assert.False(index.Within("bedroom", "ground"));
        Assert.Empty(index.Problems);
    }

    [Fact]
    public void TheCommonPlace_IsTheSmallestHoldingThemAll()
    {
        var index = LocationIndex.For(House());

        Assert.Equal("kitchen", index.Common(["kitchen"]));
        Assert.Equal("front", index.Common(["kitchen", "office"]));
        Assert.Equal("ground", index.Common(["kitchen", "garage"]));
        Assert.Equal("home", index.Common(["kitchen", "bedroom"]));
        Assert.Null(index.Common(["nowhere"]));
    }

    [Fact]
    public void DuplicateIds_AndAreasReachingAcrossFloors_AreReported()
    {
        var flow = House();
        flow.Sites[0].Floors[1].Rooms.Add(new RoomConfig { Id = "kitchen" });
        flow.Sites[0].Floors[1].Areas.Add(new AreaConfig { Id = "stairs", Rooms = { "garage" } });

        var problems = LocationIndex.For(flow).Problems;

        Assert.Contains(problems, p => p.Contains("'kitchen' is used twice"));
        Assert.Contains(problems, p => p.Contains("on another floor"));
    }

    [Fact]
    public void WhereANodeIs_ItsOwnLocationFirst_ThenRules_ThenPlacements_ThenItsCircuit()
    {
        var flow = House();
        flow.Nodes.Add(new EnergyFlowNode { Id = "fridge", Location = "kitchen" });
        flow.AutoLocations.Add(new AutoLocationRule { Match = "outlet:rack:*", Location = "office" });
        flow.AutoLocations.Add(new AutoLocationRule { Match = "outlet:rack:3", Location = "garage" });
        flow.Placements.Add(new PlacementConfig { Id = "p1", Room = "bedroom", Node = "outlet:rack:4" });
        flow.Panels.Add(new PanelConfig { Id = "main", Breakers = { new BreakerConfig { Slot = 6, Number = "B06", Rooms = { "kitchen", "garage" } } } });
        flow.Clamps.Add(new CtClampConfig { Panel = "main", Breaker = "B06", Channel = "ch5" });

        var index = LocationIndex.For(flow);

        Assert.Equal("kitchen", index.LocationOf("fridge"));
        Assert.Equal("garage", index.LocationOf("outlet:rack:3"));     // exact id beats the pattern above it
        Assert.Equal("bedroom", index.LocationOf("outlet:rack:4"));    // a placement beats a pattern
        Assert.Equal("office", index.LocationOf("outlet:rack:1"));
        Assert.Equal("ground", index.LocationOf("ch5"));               // a circuit serving two rooms is in their floor
        Assert.Null(index.LocationOf("elsewhere"));
    }

    [Fact]
    public void ARoom_IsWhatEntersItLessWhatLeaves()
    {
        var flow = House();
        flow.Nodes.Add(new EnergyFlowNode { Id = "circuit", Location = "kitchen" });
        flow.Nodes.Add(new EnergyFlowNode { Id = "kettle" });
        flow.Nodes.Add(new EnergyFlowNode { Id = "printer", Location = "office" });
        flow.Links.Add(new EnergyFlowLink { From = "circuit", To = "kettle" });
        flow.Links.Add(new EnergyFlowLink { From = "circuit", To = "printer" });

        var totals = LocationRollup.Compute(LocationIndex.For(flow), FlowTopology.For(null, flow),
            Values(new() { ["circuit"] = 500, ["printer"] = 200 }));

        // The kettle is unmetered but sits between the circuit and nothing else in the kitchen, so it is not needed.
        Assert.Equal(300, totals["kitchen"].Value);
        Assert.Equal(200, totals["office"].Value);
        Assert.Equal(500, totals["front"].Value);
        Assert.Equal(500, totals["ground"].Value);
        Assert.Equal(LocationState.Unmetered, totals["garage"].State);
        Assert.Null(totals["garage"].Value);
    }

    [Fact]
    public void AMissingReading_LeavesThePlaceUnknown_NeverAPartialSum()
    {
        var flow = House();
        flow.Nodes.Add(new EnergyFlowNode { Id = "circuit", Location = "kitchen" });
        flow.Nodes.Add(new EnergyFlowNode { Id = "printer", Location = "office" });
        flow.Nodes.Add(new EnergyFlowNode { Id = "lamp", Location = "office" });
        flow.Links.Add(new EnergyFlowLink { From = "circuit", To = "printer" });

        var totals = LocationRollup.Compute(LocationIndex.For(flow), FlowTopology.For(null, flow),
            Values(new() { ["circuit"] = 500, ["lamp"] = 40 }));

        // The printer leaves the kitchen unread, so the kitchen cannot be said; nor can the office it is in.
        Assert.Equal(LocationState.Unknown, totals["kitchen"].State);
        Assert.Null(totals["kitchen"].Value);
        Assert.Equal(["printer"], totals["kitchen"].Missing);
        Assert.Null(totals["office"].Value);
        // The front area holds both ends of the printer, so it cancels there and the total is known.
        Assert.Equal(540, totals["front"].Value);
    }

    [Fact]
    public void ANodeFedFromInsideAndOutside_IsNotSplitByGuesswork()
    {
        var flow = House();
        flow.Nodes.Add(new EnergyFlowNode { Id = "a", Location = "kitchen" });
        flow.Nodes.Add(new EnergyFlowNode { Id = "b", Location = "garage" });
        flow.Nodes.Add(new EnergyFlowNode { Id = "shared", Location = "office" });
        flow.Links.Add(new EnergyFlowLink { From = "a", To = "shared" });
        flow.Links.Add(new EnergyFlowLink { From = "b", To = "shared" });

        var totals = LocationRollup.Compute(LocationIndex.For(flow), FlowTopology.For(null, flow),
            Values(new() { ["a"] = 300, ["b"] = 300, ["shared"] = 400 }));

        Assert.Null(totals["kitchen"].Value);
        Assert.Contains("shared", totals["kitchen"].Split);
        Assert.Equal(600, totals["ground"].Value);   // all three are on the ground floor, so only what enters it counts
    }

    [Fact]
    public void ANodeTheGraphDidNotValue_IsUnknown_EvenWhereItsLinksCarryZero()
    {
        var flow = House();
        flow.Nodes.Add(new EnergyFlowNode { Id = "circuit", Location = "kitchen", Mode = "static", Value = 500 });
        flow.Nodes.Add(new EnergyFlowNode { Id = "fridge", Mode = "static", Value = 150 });
        flow.Nodes.Add(new EnergyFlowNode { Id = "grid", Kind = "grid", Mode = "none" });
        flow.Links.Add(new EnergyFlowLink { From = "grid", To = "circuit" });
        flow.Links.Add(new EnergyFlowLink { From = "circuit", To = "fridge" });

        // A static value is a power figure: the daily-energy graph has nothing for either node.
        var today = FlowGraphBuilder.Build(new rPDU2MQTT.Models.PDU.PduData(), flow, EnergyPeriod.Metric, null);
        var totals = LocationRollup.Compute(LocationIndex.For(flow), FlowTopology.For(null, flow), LocationExport.ValuesOf(today));

        Assert.Equal(LocationState.Unknown, totals["kitchen"].State);
        Assert.Null(totals["kitchen"].Value);
    }

    [Fact]
    public void AnUnplacedChild_IsWhereItsFeederIs()
    {
        var flow = House();
        flow.Nodes.Add(new EnergyFlowNode { Id = "circuit", Location = "garage" });
        flow.Nodes.Add(new EnergyFlowNode { Id = "freezer" });
        flow.Links.Add(new EnergyFlowLink { From = "circuit", To = "freezer" });

        var placed = LocationRollup.Placed(LocationIndex.For(flow), FlowTopology.For(null, flow));

        Assert.Equal("garage", placed["freezer"]);
    }

    private static EnergyFlowConfig Circuit()
    {
        var flow = House();
        flow.Panels.Add(new PanelConfig { Id = "main", Breakers = { new BreakerConfig { Slot = 6, Number = "B06" } } });
        flow.Clamps.Add(new CtClampConfig { Panel = "main", Breaker = "B06", Channel = "ch5" });
        flow.Nodes.Add(new EnergyFlowNode { Id = "fridge", Circuit = "main/B06" });
        flow.Placements.Add(new PlacementConfig { Id = "k", Kind = PlacementKind.Appliance, Room = "kitchen", Circuit = "main/B06", Node = "kettle" });
        return flow;
    }

    private static CircuitReport Report(double? fridge, double? kettle, double channel)
    {
        var flow = Circuit();
        var live = new Fixed(new() { ["ch5|realpower"] = channel });
        var values = new Dictionary<string, double?> { ["fridge"] = fridge, ["kettle"] = kettle };
        return Assert.Single(Circuits.Report(flow, live, Values(values)));
    }

    [Fact]
    public void ACircuitsRemainder_IsItsReadingLessItsMeteredDevices()
    {
        var r = Report(fridge: 150, kettle: 1200, channel: 1500);

        Assert.Equal("ch5", r.Node);
        Assert.Equal(RemainderState.Known, r.State);
        Assert.Equal(150, r.Remainder);
        Assert.False(r.Exceeded);
        Assert.Single(r.Placements);
    }

    [Fact]
    public void ADeviceWithNoReading_LeavesTheRemainderUnknown_NotZero()
    {
        var r = Report(fridge: null, kettle: 1200, channel: 1500);

        Assert.Equal(RemainderState.Unknown, r.State);
        Assert.Null(r.Remainder);
    }

    [Fact]
    public void DevicesReadingMoreThanTheirCircuit_AreFlagged_AndTheRemainderIsNotClamped()
    {
        var r = Report(fridge: 150, kettle: 1200, channel: 900);

        Assert.True(r.Exceeded);
        Assert.Equal(-450, r.Remainder);
    }

    [Fact]
    public void ADeviceAloneReadingOverItsCircuit_IsFlaggedEvenWithAnotherUnread()
    {
        var r = Report(fridge: null, kettle: 1200, channel: 900);

        Assert.True(r.Exceeded);
        Assert.Null(r.Remainder);
    }

    [Fact]
    public void ACircuitReference_SplitsOnTheFirstSlash()
    {
        Assert.Equal(("main", "26.1"), Circuits.Parse("main/26.1"));
        Assert.Null(Circuits.Parse("main"));
        Assert.Null(Circuits.Parse("/B06"));
    }
}
