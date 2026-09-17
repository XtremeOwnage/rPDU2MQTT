using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Models.Config;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// The chain from a breaker to the channel measuring it (#454): breaker → wire → clamp → channel, read from
/// either end, and a breaker's power refused whenever any link of it is missing.
/// </summary>
public class PanelMapTests
{
    private sealed class Fixed(Dictionary<string, double> v) : IFlowValueSource
    {
        public bool TryGetValue(string node, string metric, out double value) => v.TryGetValue(node + "|" + metric, out value);
    }

    /// <summary>A panel with a single-pole circuit, a double-pole range, and a breaker nobody has clamped.</summary>
    private static EnergyFlowConfig Wiring() => new()
    {
        Panels =
        {
            new PanelConfig
            {
                Id = "main_panel", Name = "Main Panel", Slots = 42,
                Breakers =
                {
                    new BreakerConfig { Slot = 6, Number = "B06", Wire = "W11", Amps = 20, Description = "Lights, Garage, Kitchen", State = BreakerState.Identified },
                    new BreakerConfig { Slot = 1, Number = "1,3", Poles = 2, Amps = 60, Description = "AC Heat Strips", State = BreakerState.Identified },
                    new BreakerConfig { Slot = 9, Number = "B09", Wire = "W04", State = BreakerState.Unknown },
                },
            },
        },
        Clamps =
        {
            new CtClampConfig { Label = "C1", Amps = 50, Panel = "main_panel", Breaker = "B06", Channel = "n30_1_5" },
            new CtClampConfig { Label = "C2", Amps = 100, Panel = "main_panel", Breaker = "1,3", Leg = 1, Wire = "W01", Channel = "n30_1_1" },
            new CtClampConfig { Label = "C3", Amps = 100, Panel = "main_panel", Breaker = "1,3", Leg = 2, Wire = "W02", Channel = "n30_1_2" },
        },
    };

    [Fact]
    public void ABreakerCarriesItsChain_ToTheChannelMeasuringIt()
    {
        var map = PanelMap.For(Wiring());

        var b06 = map.Breaker("main_panel", "B06")!;
        var leg = Assert.Single(b06.Legs);
        Assert.Equal("W11", leg.Wire);            // the clamp names no wire, so the breaker's own wire stands
        Assert.Equal("C1", leg.Clamp!.Label);
        Assert.Equal("n30_1_5", leg.Channel);

        // A double-pole has a wire and a clamp per leg, and the clamp's own wire label wins where it has one.
        var range = map.Breaker("main_panel", "1,3")!;
        Assert.Equal(2, range.Legs.Count);
        Assert.Equal(new[] { "W01", "W02" }, range.Legs.Select(l => l.Wire));
        Assert.Equal(new[] { "n30_1_1", "n30_1_2" }, range.Legs.Select(l => l.Channel));

        // A breaker nobody has clamped still has its leg, with nothing on it.
        var b09 = map.Breaker("main_panel", "B09")!;
        Assert.Null(Assert.Single(b09.Legs).Clamp);
        Assert.Null(b09.Legs[0].Channel);
    }

    [Fact]
    public void TheChainReadsFromEitherEnd()
    {
        var map = PanelMap.For(Wiring());

        Assert.Equal("B06", map.ByChannel("n30_1_5")!.Breaker.Number);
        Assert.Equal("B06", map.ByWire("W11")!.Breaker.Number);
        Assert.Equal("B06", map.ByClamp("C1")!.Breaker.Number);
        Assert.Equal("1,3", map.ByChannel("n30_1_2")!.Breaker.Number);
        Assert.Equal("1,3", map.ByWire("W02")!.Breaker.Number);

        Assert.Null(map.ByChannel("n30_9_9"));
        Assert.Null(map.ByWire("W99"));
        Assert.Null(map.ByClamp("nope"));
        Assert.Null(map.Breaker("main_panel", "B99"));
    }

    [Fact]
    public void PowerComesFromTheChannels_AndADoublePoleSumsBothLegs()
    {
        var map = PanelMap.For(Wiring());
        var live = new Fixed(new() { ["n30_1_5|realpower"] = 240, ["n30_1_1|realpower"] = 1100, ["n30_1_2|realpower"] = 1150 });

        Assert.Equal(240, PanelMap.Power(map.Breaker("main_panel", "B06")!, live));
        Assert.Equal(2250, PanelMap.Power(map.Breaker("main_panel", "1,3")!, live));
    }

    [Fact]
    public void HalfADoublePole_IsNotTheBreakersPower()
    {
        var map = PanelMap.For(Wiring());
        // Only one leg is reporting: the sum would be half the truth, so nothing is reported at all.
        var live = new Fixed(new() { ["n30_1_1|realpower"] = 1100 });

        var power = PanelMap.Power(map.Breaker("main_panel", "1,3")!, live, "realpower", out var gap);
        Assert.Null(power);
        Assert.Equal(PowerGap.NoReading, gap);
    }

    [Fact]
    public void EachMissingLink_LeavesThePowerUnknown_AndSaysWhichLinkItWas()
    {
        var wiring = Wiring();
        var live = new Fixed(new() { ["n30_1_5|realpower"] = 240 });

        // No clamp on the wire at all.
        var unclamped = PanelMap.For(wiring).Breaker("main_panel", "B09")!;
        Assert.Null(PanelMap.Power(unclamped, live, "realpower", out var noClamp));
        Assert.Equal(PowerGap.NoClamp, noClamp);

        // A clamp that is not plugged into anything.
        wiring.Clamps.Add(new CtClampConfig { Label = "C4", Panel = "main_panel", Breaker = "B09", Wire = "W04" });
        var unplugged = PanelMap.For(wiring).Breaker("main_panel", "B09")!;
        Assert.Null(PanelMap.Power(unplugged, live, "realpower", out var noChannel));
        Assert.Equal(PowerGap.NoChannel, noChannel);

        // Plugged in, but that channel has nothing to say.
        wiring.Clamps.Last().Channel = "n30_2_7";
        var silent = PanelMap.For(wiring).Breaker("main_panel", "B09")!;
        Assert.Null(PanelMap.Power(silent, live, "realpower", out var noReading));
        Assert.Equal(PowerGap.NoReading, noReading);

        // …and with a reading it is known, which is what makes the refusals above mean something.
        var heard = new Fixed(new() { ["n30_2_7|realpower"] = 60 });
        Assert.Equal(60, PanelMap.Power(silent, heard, "realpower", out var none));
        Assert.Equal(PowerGap.None, none);

        // No live source at all is the same refusal, not a zero.
        Assert.Null(PanelMap.Power(silent, null, "realpower", out var nothing));
        Assert.Equal(PowerGap.NoReading, nothing);
    }

    [Fact]
    public void AReversedClampIsFlipped_RatherThanBelievedAsANegativeLoad()
    {
        var wiring = Wiring();
        wiring.Clamps.First(c => c.Label == "C1").Reversed = true;
        var map = PanelMap.For(wiring);
        var live = new Fixed(new() { ["n30_1_5|realpower"] = -240 });

        Assert.Equal(240, PanelMap.Power(map.Breaker("main_panel", "B06")!, live));
    }

    [Fact]
    public void AClampOnAnotherPanelsBreakerOfTheSameNumber_IsNotThisOnes()
    {
        var wiring = Wiring();
        wiring.Panels.Add(new PanelConfig
        {
            Id = "sub_panel", Name = "Sub Panel", Slots = 24,
            Breakers = { new BreakerConfig { Slot = 6, Number = "B06", Wire = "W60" } },
        });
        var map = PanelMap.For(wiring);

        // Both panels have a B06; the clamp belongs to the one it names.
        Assert.Equal("n30_1_5", map.Breaker("main_panel", "B06")!.Legs[0].Channel);
        Assert.Null(map.Breaker("sub_panel", "B06")!.Legs[0].Clamp);
    }

    [Fact]
    public void NoPanels_IsAnEmptyMap_NotAFailure()
    {
        var map = PanelMap.For(new EnergyFlowConfig());
        Assert.Empty(map.Chains);
        Assert.Null(map.ByChannel("n30_1_5"));

        Assert.Empty(PanelMap.For(null).Chains);
    }
}
