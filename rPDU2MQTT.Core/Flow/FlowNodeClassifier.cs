using rPDU2MQTT.Models.Config;

namespace rPDU2MQTT.Core.Flow;

/// <summary>
/// Decides how a config node is valued — shared by everything that walks the tree, so they agree. A node is
/// a <c>measured</c> leaf when
/// it has a live source or a static value, <c>residual</c> when its mode says so, else an <c>aggregate</c>.
/// </summary>
public static class FlowNodeClassifier
{
    public static string TypeOf(EnergyFlowNode n)
        => n.AllSources().Any() || n.Value.HasValue ? "measured"
         : string.Equals(n.Mode, "residual", System.StringComparison.OrdinalIgnoreCase) ? "residual"
         : "aggregate";
}
