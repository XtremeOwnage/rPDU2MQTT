using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Models.PDU;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// A node bound to a source that goes quiet must not quietly become the sum of its children.
/// <para>
/// The bug these pin: a solar node bound to a lifetime energy counter also had three MPPT children metering
/// the same array from an origin 96.96 kWh earlier. Whenever the counter missed a poll the node's value
/// switched to the children's roll-up, and the cumulative export — which keeps a high-water mark so a
/// counter never runs backwards — latched that higher number. Every later reading from the real counter then
/// sat below the mark and was withheld, so Home Assistant recorded a whole day's generation in one hour
/// (64.76 kWh, the roll-up's delta) and never received the remaining 5.49 kWh.
/// </para>
/// <para>
/// Summing children is a legitimate way to value a node. Substituting it for a reading somebody promised is
/// not: the two count the same energy from different origins, and swapping between them mid-series turns a
/// cumulative export into nonsense deltas.
/// </para>
/// </summary>
public class DerivationSwapTests
{
    private sealed class Fixed : IFlowValueSource
    {
        private readonly Dictionary<string, double> v;
        public Fixed(Dictionary<string, double> x) => v = x;
        public bool TryGetValue(string node, string metric, out double value) => v.TryGetValue(node + "|" + metric, out value);
    }

    /// <summary>solar, bound to its own lifetime energy counter, fed by three metered MPPTs.</summary>
    private static EnergyFlowConfig Array()
    {
        var c = new EnergyFlowConfig();
        c.Nodes.Add(new EnergyFlowNode
        {
            Id = "solar",
            Kind = "solar",
            Sources = { new EnergyFlowSource { Type = "mqtt", Metric = "energy", Accumulation = "lifetime" } },
        });
        foreach (var n in new[] { "mppt1", "mppt2", "mppt3" })
        {
            c.Nodes.Add(new EnergyFlowNode { Id = n });
            c.Links.Add(new EnergyFlowLink { From = n, To = "solar" });
        }
        return c;
    }

    /// <summary>The live figures on the day this was reported: the MPPTs total 432.23 kWh, the node's own
    /// counter 335.40 — the same energy, 96.83 apart, because the MPPTs started counting earlier.</summary>
    private static Dictionary<string, double> Mppts() => new()
    {
        ["mppt1|energy"] = 123.19,
        ["mppt2|energy"] = 156.73,
        ["mppt3|energy"] = 152.31,
    };

    private static FlowNode Node(FlowGraph g, string id) => g.Nodes.Single(n => n.Id == id);

    [Fact]
    public void ABoundSourceThatReports_IsTheNodesValue()
    {
        var live = Mppts();
        live["solar|energy"] = 335.40;

        var solar = Node(FlowGraphBuilder.Build(new PduData(), Array(), "energy", new Fixed(live)), "solar");

        Assert.Equal(335.40, solar.Value);
        Assert.Equal(FlowDerivation.Measured, solar.Derivation);
    }

    [Fact]
    public void ABoundSourceThatGoesQuiet_LeavesTheNodeUnknown_NotItsChildrensTotal()
    {
        var solar = Node(FlowGraphBuilder.Build(new PduData(), Array(), "energy", new Fixed(Mppts())), "solar");

        // 432.23 here is what shipped: a number 96.83 above the counter it replaced, latched by the export's
        // high-water mark and never given up.
        Assert.Null(solar.Value);
        Assert.Equal(FlowDerivation.Unknown, solar.Derivation);
    }

    [Fact]
    public void ANodeWithNoBoundSource_StillSumsItsChildren()
    {
        var c = Array();
        c.Nodes.Single(n => n.Id == "solar").Sources.Clear();

        var solar = Node(FlowGraphBuilder.Build(new PduData(), c, "energy", new Fixed(Mppts())), "solar");

        // Nothing was promised for this node, so the roll-up is the only thing its value could mean — and it
        // is a legitimate figure, not a stand-in for one that failed to arrive.
        Assert.Equal(432.23, solar.Value!.Value, 2);
        Assert.Equal(FlowDerivation.Summed, solar.Derivation);
    }

    [Fact]
    public void ABindingForOneMetric_SaysNothingAboutAnother()
    {
        // The binding is for energy. Power was never promised for this node, so it still rolls up.
        var g = FlowGraphBuilder.Build(new PduData(), Array(), "realpower", new Fixed(new()
        {
            ["mppt1|realpower"] = 1000,
            ["mppt2|realpower"] = 1200,
            ["mppt3|realpower"] = 1100,
        }));

        Assert.Equal(3300, Node(g, "solar").Value);
        Assert.Equal(FlowDerivation.Summed, Node(g, "solar").Derivation);
    }
}
