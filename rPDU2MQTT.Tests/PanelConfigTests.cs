using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Services.Gui;
using rPDU2MQTT.Startup;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// The panel directory in config (#452): the slots a breaker occupies, tandem halves, the unidentified
/// circuits, and that a directory written in YAML or JSON comes back as it was written.
/// </summary>
public class PanelConfigTests
{
    [Fact]
    public void Slots_AreNumberedAsThePanelIs()
    {
        var panel = new PanelConfig { Slots = 42 };

        // Odd down the left, even down the right, two to a row — the way the numbers are stamped.
        Assert.True(PanelConfig.IsLeft(1));
        Assert.False(PanelConfig.IsLeft(2));
        Assert.Equal(1, PanelConfig.RowOf(1));
        Assert.Equal(1, PanelConfig.RowOf(2));
        Assert.Equal(2, PanelConfig.RowOf(3));
        Assert.Equal(21, panel.Rows);
        Assert.True(panel.HasSlot(42));
        Assert.False(panel.HasSlot(43));
        Assert.False(panel.HasSlot(0));
    }

    [Fact]
    public void DoublePole_HoldsTheNextSlotInItsOwnColumn()
    {
        // 1 and 3 are the two slots a double-pole spans: the next one down the same column, not the one beside it.
        var heatStrips = new BreakerConfig { Slot = 1, Poles = 2, Number = "1,3", Amps = 60, Description = "AC Heat Strips" };

        Assert.Equal(new[] { 1, 3 }, heatStrips.Occupies());
        Assert.Equal(new[] { 6 }, new BreakerConfig { Slot = 6 }.Occupies());
    }

    [Fact]
    public void TandemHalves_ShareOneSlot_AndDoNotCollide()
    {
        var upper = new BreakerConfig { Slot = 26, Half = 1, Number = "26.1", Wire = "W21", Description = "N utility room. Servers" };
        var lower = new BreakerConfig { Slot = 26, Half = 2, Number = "26.2", Wire = "W22", State = BreakerState.Unused };

        Assert.False(upper.Collides(lower));
        Assert.False(lower.Collides(upper));
        Assert.False(upper.Collides(upper));

        // A whole-slot breaker in the same slot does collide: the slot cannot hold both.
        var whole = new BreakerConfig { Slot = 26, Number = "26" };
        Assert.True(whole.Collides(upper));
        Assert.True(upper.Collides(whole));

        // …and so does a double-pole reaching down into it.
        Assert.True(new BreakerConfig { Slot = 24, Poles = 2 }.Collides(new BreakerConfig { Slot = 26 }));
        Assert.False(new BreakerConfig { Slot = 24, Poles = 2 }.Collides(new BreakerConfig { Slot = 25 }));
    }

    [Fact]
    public void ABreakerStartsUnknown_SoABlankRowClaimsNothing()
    {
        Assert.Equal(BreakerState.Unknown, new BreakerConfig().State);
        Assert.Equal(1, new BreakerConfig().Poles);
        Assert.Null(new BreakerConfig().Half);
        Assert.Equal(42, new PanelConfig().Slots);
        Assert.Empty(new PanelConfig().Breakers);
        Assert.Empty(new EnergyFlowConfig().Panels);
    }

    [Fact]
    public void ADirectoryWrittenInYaml_ComesBackAsItWasWritten()
    {
        // The paper directory this models: a double-pole, an identified circuit with its wire, an
        // unidentified one, and a tandem half that feeds nothing.
        var config = YamlConfigLoader.DeserializeString("""
            EnergyFlow:
              Panels:
                - Id: main_panel
                  Name: Main Panel
                  Slots: 42
                  Node: main_panel_feed
                  Breakers:
                    - Slot: 1
                      Number: "1,3"
                      Poles: 2
                      Amps: 60
                      Description: AC Heat Strips
                      State: identified
                    - Slot: 6
                      Number: B06
                      Wire: W11
                      Amps: 20
                      Description: Lights, Garage, Kitchen
                      State: identified
                    - Slot: 9
                      Number: B09
                      Wire: W04
                      Description: Bathroom Lights
                      State: unknown
                    - Slot: 26
                      Half: 2
                      Number: "26.2"
                      Wire: W22
                      State: unused
            """);

        var panel = Assert.Single(config.EnergyFlow.Panels);
        Assert.Equal("main_panel", panel.Id);
        Assert.Equal("Main Panel", panel.Name);
        // The node that is the panel: what its incoming power is read from, and what its circuits hang beneath.
        Assert.Equal("main_panel_feed", panel.Node);
        Assert.Equal("", new PanelConfig().Node);
        Assert.Equal(42, panel.Slots);
        Assert.Equal(4, panel.Breakers.Count);

        var heatStrips = panel.Breakers[0];
        Assert.Equal(new[] { 1, 3 }, heatStrips.Occupies());
        Assert.Equal(60, heatStrips.Amps);

        var garage = panel.Breakers[1];
        Assert.Equal("W11", garage.Wire);
        Assert.Equal("Lights, Garage, Kitchen", garage.Description);
        Assert.Equal(BreakerState.Identified, garage.State);

        // The "????" row: recorded, and still marked as nobody's guess.
        Assert.Equal(BreakerState.Unknown, panel.Breakers[2].State);

        var tandem = panel.Breakers[3];
        Assert.Equal(2, tandem.Half);
        Assert.Equal(BreakerState.Unused, tandem.State);

        // No two breakers in the directory claim the same slot.
        Assert.All(panel.Breakers, b => Assert.DoesNotContain(panel.Breakers, other => b.Collides(other)));
    }

    [Fact]
    public void ADirectoryWrittenInJson_ComesBackAsItWasWritten()
    {
        var config = ConfigSchema.FromJson(
            """{"EnergyFlow":{"Panels":[{"Id":"sub_panel","Name":"Sub Panel","Slots":24,"Breakers":[{"Slot":5,"Number":"5","Poles":1,"Amps":15,"Wire":"W31","Description":"Office","State":"identified"}]}]}}""");

        var panel = Assert.Single(config.EnergyFlow.Panels);
        Assert.Equal(24, panel.Slots);
        Assert.Equal(12, panel.Rows);
        var office = Assert.Single(panel.Breakers);
        Assert.Equal("W31", office.Wire);
        Assert.Equal(15, office.Amps);
        Assert.Equal(BreakerState.Identified, office.State);
    }

    [Fact]
    public void HowManyRowsThePanelHas_IsDerived_AndNeverWrittenIntoTheDocument()
    {
        // It was: a panel added in the GUI saved "Rows: 21" into the config document and the CR with it.
        var config = new rPDU2MQTT.Classes.Config();
        config.EnergyFlow.Panels.Add(new PanelConfig { Id = "main_panel", Name = "Main Panel", Slots = 42 });

        var json = System.Text.Json.JsonSerializer.Serialize(config, ConfigSchema.ConfigJsonOptions);
        var yaml = ConfigSchema.ToYaml(config);

        Assert.DoesNotContain("\"Rows\"", json);
        Assert.DoesNotContain("Rows:", yaml);
        // …and the document still carries the slot count it is derived from.
        Assert.Contains("\"Slots\"", json);
        Assert.Equal(21, config.EnergyFlow.Panels[0].Rows);
    }

    /// <summary>The fields of one item of a list, wherever the schema hangs them.</summary>
    private static List<SchemaNode> Fields(SchemaNode node) => node.ValueSchema?.Properties ?? node.Properties ?? new();

    [Fact]
    public void ThePanelDirectory_IsOfferedInTheSchema()
    {
        var flow = Assert.Single(ConfigSchema.Build(), n => n.Key == "EnergyFlow");
        var panels = Assert.Single(flow.Properties!, c => c.Key == "Panels");
        Assert.False(string.IsNullOrWhiteSpace(panels.Description));

        Assert.Single(Fields(panels), c => c.Key == "Node");
        var breakers = Assert.Single(Fields(panels), c => c.Key == "Breakers");
        var state = Assert.Single(Fields(breakers), c => c.Key == "State");
        // The three states are offered as a choice, so a directory cannot be given a fourth by typing one.
        // The leading blank is the editor's "leave it to the default", which reads as unknown.
        Assert.Equal(BreakerState.All.Prepend("").ToArray(), state.EnumValues);
        Assert.Equal(BreakerState.Unknown, state.Default);
        Assert.Equal(BreakerState.Unknown, BreakerState.Of(""));
        Assert.Equal(BreakerState.Unknown, BreakerState.Of(null));
        Assert.Equal(BreakerState.Identified, BreakerState.Of(BreakerState.Identified));
    }
}
