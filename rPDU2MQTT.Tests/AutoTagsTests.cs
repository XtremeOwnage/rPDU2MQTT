using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Models.PDU;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// Tags for the nodes nobody typed out. An outlet exists because the PDU reports it, so it has no config
/// entry to carry a tag — filtering a view or gating an export by "rack 1" worked for custom nodes and was
/// impossible for the hundreds of outlets underneath them.
/// </summary>
public class AutoTagsTests
{
    [Fact]
    public void OneRuleCoversAWholePdusOutlets()
    {
        List<AutoTagRule> rules = [new() { Match = "outlet:rack_pdu_1:*", Tags = ["rack-1"] }];

        Assert.Equal(["rack-1"], AutoTags.For(rules, "outlet:rack_pdu_1:4"));
        Assert.Empty(AutoTags.For(rules, "outlet:rack_pdu_2:4"));
        Assert.Empty(AutoTags.For(rules, "pdu:rack_pdu_1"));
    }

    [Fact]
    public void RulesStack_AndDoNotRepeatATag()
    {
        List<AutoTagRule> rules = [
            new() { Match = "outlet:*", Tags = ["metered"] },
            new() { Match = "outlet:rack_pdu_1:3", Tags = ["critical", "metered"] },
        ];

        Assert.Equal(["metered"], AutoTags.For(rules, "outlet:rack_pdu_1:4"));
        Assert.Equal(["metered", "critical"], AutoTags.For(rules, "outlet:rack_pdu_1:3"));
    }

    [Fact]
    public void NothingIsInheritedByAccident()
    {
        // A tag on the PDU is a tag on the PDU. Quietly pushing it onto every outlet would make an export
        // gate include readings nobody listed.
        List<AutoTagRule> rules = [new() { Match = "pdu:rack_pdu_1", Tags = ["rack-1"] }];

        Assert.Equal(["rack-1"], AutoTags.For(rules, "pdu:rack_pdu_1"));
        Assert.Empty(AutoTags.For(rules, "outlet:rack_pdu_1:1"));
    }

    [Fact]
    public void APatternIsGlob_NotRegex()
    {
        // Outlet ids are full of ':' and a PDU's name can hold a '.'; either read as a regex matches far
        // more than the pattern appears to say.
        Assert.False(AutoTags.Matches("outlet:rack.pdu:1", "outlet:rackxpdu:1"));
        Assert.True(AutoTags.Matches("outlet:rack.pdu:1", "outlet:rack.pdu:1"));
        Assert.False(AutoTags.Matches("outlet:a+", "outlet:aaa"));
    }

    [Fact]
    public void BlankRulesAndBlankTagsAreIgnored()
    {
        List<AutoTagRule> rules = [
            new() { Match = "", Tags = ["everything"] },
            new() { Match = "outlet:*", Tags = ["  ", ""] },
        ];

        Assert.Empty(AutoTags.For(rules, "outlet:rack_pdu_1:1"));
    }

    [Fact]
    public void TheGraphCarriesThemOntoTheDerivedNodes()
    {
        // The property that matters: the tag reaches the node the diagram and the export filter read.
        var data = new PduData();
        var device = new Device { Entity_Name = "rack_pdu_1", Entity_DisplayName = "Rack PDU 1" };
        device.Outlets.Add(new Outlet
        {
            Key = 3, Entity_Name = "outlet3", Entity_DisplayName = "Outlet 3",
            Measurements = { new Measurement { Type = "realpower", Value = "42", Units = "W" } },
        });
        data.Devices.Add(device);

        var flow = new EnergyFlowConfig();
        flow.AutoTags.Add(new AutoTagRule { Match = "outlet:rack_pdu_1:*", Tags = ["rack-1"] });
        flow.AutoTags.Add(new AutoTagRule { Match = "pdu:*", Tags = ["pdu"] });

        var graph = FlowGraphBuilder.Build(data, flow, "realpower");

        Assert.Equal(["rack-1"], graph.Nodes.Single(n => n.Id == "outlet:rack_pdu_1:3").Tags!);
        Assert.Equal(["pdu"], graph.Nodes.Single(n => n.Id == "pdu:rack_pdu_1").Tags!);
    }
}
