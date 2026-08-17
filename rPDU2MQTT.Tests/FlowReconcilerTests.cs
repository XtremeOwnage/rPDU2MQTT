using rPDU2MQTT.Hosting;
using rPDU2MQTT.Models.Config;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// The node classifier: is a node a measured leaf, an aggregate, or the designated residual?
///
/// <para>
/// Its consumers — the flow reconciler and the node grains — went with Orleans, and FlowGraphBuilder makes
/// the same decision inline rather than calling this. It is kept because it is the one place that rule is
/// written down and tested; the builder should adopt it, which is a change worth making deliberately
/// rather than in the middle of removing a framework.
/// </para>
/// </summary>
public class FlowNodeClassifierTests
{
    [Theory]
    [InlineData(false, null, "auto", "aggregate")]
    [InlineData(true, null, "auto", "measured")]        // has a source
    [InlineData(false, 42.0, "auto", "measured")]       // has a static value
    [InlineData(false, null, "residual", "residual")]
    public void Classifies_By_Source_Value_And_Mode(bool hasSource, double? value, string mode, string expected)
    {
        var n = new rPDU2MQTT.Models.Config.EnergyFlowNode { Id = "n", Mode = mode, Value = value };
        if (hasSource) n.Sources.Add(new rPDU2MQTT.Models.Config.EnergyFlowSource { Type = "modbus", Metric = "realpower" });
        Assert.Equal(expected, rPDU2MQTT.Core.Flow.FlowNodeClassifier.TypeOf(n));
    }
}
