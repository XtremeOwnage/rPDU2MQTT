namespace rPDU2MQTT.Core.Flow;

/// <summary>One line on a chart of history: a node, or the return lane belonging to one.</summary>
public readonly record struct FlowLane(string Id, string Label, string Kind, IReadOnlyList<string>? Tags);

/// <summary>
/// Which series a chart of history is made of.
///
/// <para>
/// A return lane — grid export, battery charge — is a measurement held in history under its own id, but it
/// is only a node in the live graph while something is flowing back at that instant. Reading the chart's
/// lines off the live graph therefore left export out of a chart of last month whenever nothing happened to
/// be exporting when the page was opened, and the page said "no export series is in history for this
/// window" — which was never the question it had asked.
/// </para>
/// <para>
/// So the lanes are named here, from the nodes alone: every node, and the return lane that belongs to it.
/// A lane the backend holds nothing for drops out on the way back, which is the honest way to find out.
/// </para>
/// </summary>
public static class FlowLanes
{
    public static IReadOnlyList<FlowLane> For(IEnumerable<FlowNode> nodes)
        => nodes
            .Where(n => !n.Synthetic)
            .SelectMany(n => new[]
            {
                new FlowLane(n.Id, n.Label, n.Kind, n.Tags),
                new FlowLane(n.Id + FlowMetricKey.InSuffix, FlowMetricKey.ReturnLabel(n.Label, n.Kind), n.Kind, n.Tags),
            })
            .ToList();
}
