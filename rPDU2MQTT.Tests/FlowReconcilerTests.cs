using rPDU2MQTT.Hosting;
using rPDU2MQTT.Models.Config;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// The flow reconciler's config → node-tree mapping: node types are classified (measured/aggregate/residual)
/// and children are the feeders wired into each node (panel → string → MPPT).
/// </summary>
public class FlowReconcilerTests
{
    [Fact]
    public void Plan_ClassifiesTypes_AndWiresFeederChildren()
    {
        var flow = new EnergyFlowConfig
        {
            Nodes =
            {
                new EnergyFlowNode { Id = "panel-1", Sources = { new EnergyFlowSource { Type = "modbus", Metric = "realpower" } } },
                new EnergyFlowNode { Id = "panel-2", Value = 250 },                 // static leaf
                new EnergyFlowNode { Id = "string-1" },                              // aggregate (no source/value)
                new EnergyFlowNode { Id = "mppt-1" },                                // aggregate
                new EnergyFlowNode { Id = "untracked", Mode = "residual" },          // residual
            },
            Links =
            {
                new EnergyFlowLink { From = "panel-1", To = "string-1" },
                new EnergyFlowLink { From = "panel-2", To = "string-1" },
                new EnergyFlowLink { From = "string-1", To = "mppt-1" },
            },
        };

        var plans = FlowReconciler.Plan(flow).ToDictionary(p => p.Id, p => p);

        Assert.Equal("measured", plans["panel-1"].Type);   // has a source
        Assert.Equal("measured", plans["panel-2"].Type);   // has a static value
        Assert.Equal(250, plans["panel-2"].StaticValue);
        Assert.Equal("aggregate", plans["string-1"].Type);
        Assert.Equal("residual", plans["untracked"].Type);

        // string-1 aggregates its two feeder panels; mppt-1 aggregates the string.
        Assert.Equal(new[] { "panel-1", "panel-2" }, plans["string-1"].Spec.Children.Select(c => c.Id).OrderBy(x => x));
        Assert.All(plans["string-1"].Spec.Children, c => Assert.Equal("measured", c.Type));
        Assert.Equal(new[] { "string-1" }, plans["mppt-1"].Spec.Children.Select(c => c.Id));
        Assert.Equal("aggregate", plans["mppt-1"].Spec.Children[0].Type);
    }
}
