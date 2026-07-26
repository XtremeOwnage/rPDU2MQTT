using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Models.Config;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// A node group's total is the sum of its members — and, like everything else in the flow, it never invents
/// one. A group whose members are all "no data" is itself unknown; a known member counts, an unknown one
/// does not (it is not treated as zero).
/// </summary>
public class FlowGroupsTests
{
    private static FlowGraph Graph(params FlowNode[] nodes)
        => new(nodes, System.Array.Empty<FlowLink>(), "realpower", "W");

    private static EnergyFlowGroup Group(params string[] members)
        => new() { Id = "incoming_pv", Label = "Incoming PV", Kind = "solar", Members = members.ToList() };

    [Fact]
    public void Total_SumsTheMembersThatHaveAValue()
    {
        var graph = Graph(
            new FlowNode("mppt1", "MPPT 1", "solar", 300),
            new FlowNode("mppt2", "MPPT 2", "solar", 320),
            new FlowNode("mppt3", "MPPT 3", "solar", 280));

        var total = FlowGroups.Total(graph, Group("mppt1", "mppt2", "mppt3"));

        Assert.Equal(900, total.Value);
        Assert.Equal(3, total.MemberCount);
        Assert.Equal("Incoming PV", total.Label);
        Assert.Equal("solar", total.Kind);
    }

    [Fact]
    public void AnUnknownMember_IsSkipped_NotCountedAsZero()
    {
        // MPPT 2 has no data. The group is the sum of the two that do — not (300+0+280) implying MPPT 2 is
        // off, and not null just because one member is missing.
        var graph = Graph(
            new FlowNode("mppt1", "MPPT 1", "solar", 300),
            new FlowNode("mppt2", "MPPT 2", "solar", null),
            new FlowNode("mppt3", "MPPT 3", "solar", 280));

        var total = FlowGroups.Total(graph, Group("mppt1", "mppt2", "mppt3"));

        Assert.Equal(580, total.Value);
        Assert.Equal(2, total.MemberCount);
    }

    [Fact]
    public void AllMembersUnknown_MakesTheGroupUnknown_NotZero()
    {
        // Solar at night: every MPPT is "no data". The group must be unknown, never a fabricated 0 W that an
        // exporter would publish into history.
        var graph = Graph(
            new FlowNode("mppt1", "MPPT 1", "solar", null),
            new FlowNode("mppt2", "MPPT 2", "solar", null));

        var total = FlowGroups.Total(graph, Group("mppt1", "mppt2"));

        Assert.Null(total.Value);
        Assert.Equal(0, total.MemberCount);
    }

    [Fact]
    public void AMeasuredZeroMember_Counts_AsZero()
    {
        // A member that really measured 0 W is known — the group has a value (it's not unknown), and that
        // member contributes 0.
        var graph = Graph(
            new FlowNode("mppt1", "MPPT 1", "solar", 0),
            new FlowNode("mppt2", "MPPT 2", "solar", 150));

        var total = FlowGroups.Total(graph, Group("mppt1", "mppt2"));

        Assert.Equal(150, total.Value);
        Assert.Equal(2, total.MemberCount);
    }

    [Fact]
    public void Totals_SkipsBlankIds_AndReadsEveryConfiguredGroup()
    {
        var graph = Graph(new FlowNode("a", "A", "node", 10), new FlowNode("b", "B", "node", 20));
        var flow = new EnergyFlowConfig
        {
            Groups =
            {
                new EnergyFlowGroup { Id = "g1", Members = { "a", "b" } },
                new EnergyFlowGroup { Id = "", Members = { "a" } },   // blank id — ignored
            },
        };

        var totals = FlowGroups.Totals(graph, flow).ToList();
        Assert.Single(totals);
        Assert.Equal(30, totals[0].Value);
    }
}
