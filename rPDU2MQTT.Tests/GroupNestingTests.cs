using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Models.Config;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// A group anchor and its members must not both deliver into the same target.
///
/// <para>
/// The anchor's reading already is the members' total, so wiring both into one node counts the same energy
/// twice. Taken from a live system: an inverter fed by Solar and by MPPT_1/2/3, where Solar reads exactly
/// what the three MPPTs sum to.
/// </para>
/// </summary>
public class GroupNestingTests
{
    private static EnergyFlowConfig Config(params (string From, string To)[] links)
    {
        var cfg = new EnergyFlowConfig();
        foreach (var id in new[] { "solar", "MPPT_1", "MPPT_2", "MPPT_3", "inverter", "panel" })
            cfg.Nodes.Add(new EnergyFlowNode { Id = id });
        cfg.Groups.Add(new EnergyFlowGroup { Id = "solar", Members = { "MPPT_1", "MPPT_2", "MPPT_3" } });
        foreach (var (f, t) in links) cfg.Links.Add(new EnergyFlowLink { From = f, To = t });
        return cfg;
    }

    private static string[] Edges(EnergyFlowConfig cfg)
        => FlowGraphBuilder.NestGroupMembers(cfg).Select(l => $"{l.From}->{l.To}").OrderBy(x => x).ToArray();

    [Fact]
    public void MembersFeedingTheAnchorsTargetAreNestedUnderTheAnchor()
    {
        var edges = Edges(Config(
            ("solar", "inverter"), ("MPPT_1", "inverter"), ("MPPT_2", "inverter"), ("MPPT_3", "inverter")));

        // The strings feed the array; the array feeds the inverter. PV arrives once.
        Assert.Equal(new[] { "MPPT_1->solar", "MPPT_2->solar", "MPPT_3->solar", "solar->inverter" }, edges);
    }

    [Fact]
    public void AMemberPathTheAnchorDoesNotCoverIsLeftAlone()
    {
        // MPPT_3 also feeds a panel the anchor never feeds — a real, separate path, not a duplicate.
        var edges = Edges(Config(
            ("solar", "inverter"), ("MPPT_1", "inverter"), ("MPPT_3", "panel")));

        Assert.Contains("MPPT_3->panel", edges);
        Assert.Contains("MPPT_1->solar", edges);
    }

    [Fact]
    public void ASyntheticGroupWithNoNodeOfItsOwnIsUntouched()
    {
        var cfg = Config(("MPPT_1", "inverter"), ("MPPT_2", "inverter"));
        cfg.Nodes.RemoveAll(n => n.Id == "solar");   // group id is not a node -> nothing to double count

        Assert.Equal(new[] { "MPPT_1->inverter", "MPPT_2->inverter" }, Edges(cfg));
    }

    [Fact]
    public void AMemberAlreadyWiredToItsAnchorDoesNotBecomeASelfLoop()
    {
        var edges = Edges(Config(("solar", "inverter"), ("MPPT_1", "solar"), ("MPPT_1", "inverter")));

        Assert.DoesNotContain(edges, e => e == "solar->solar");
        Assert.Single(edges, e => e == "MPPT_1->solar");   // the rewrite collides with the existing link, once
    }

    [Fact]
    public void TheAnchorsOwnLinkSurvives()
    {
        Assert.Contains("solar->inverter", Edges(Config(("solar", "inverter"), ("MPPT_1", "inverter"))));
    }
}
