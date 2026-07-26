using rPDU2MQTT.Models.Config;

namespace rPDU2MQTT.Core.Flow;

/// <summary>One group's rolled-up value for a metric — the sum of the members that actually have one.</summary>
/// <param name="Id">The group id (its export key).</param>
/// <param name="Label">Display label.</param>
/// <param name="Kind">Node kind, for styling.</param>
/// <param name="Value">The summed value, or <see langword="null"/> when no member has a known value.</param>
/// <param name="MemberCount">How many members contributed a known value.</param>
public sealed record FlowGroupValue(string Id, string Label, string Kind, double? Value, int MemberCount);

/// <summary>
/// Rolls a node group up to a single value — the sum of its members (#groups).
/// <para>
/// The same honesty rule as the rest of the flow applies: a group is the sum of the members that have a
/// <b>known</b> value, and it is itself unknown (null) when none of them do. It never invents a total for a
/// group whose members are all "no data", and it never counts an unknown member as zero.
/// </para>
/// </summary>
public static class FlowGroups
{
    /// <summary>The group's value for the metric this graph carries, from its members' node values.</summary>
    public static FlowGroupValue Total(FlowGraph graph, EnergyFlowGroup group)
    {
        double sum = 0;
        var known = 0;
        foreach (var memberId in group.Members)
            if (FlowExport.TryNodeValue(graph, memberId, out var v)) { sum += v; known++; }

        var label = string.IsNullOrWhiteSpace(group.Label) ? group.Id : group.Label;
        var kind = string.IsNullOrWhiteSpace(group.Kind) ? "node" : group.Kind.Trim().ToLowerInvariant();
        return new FlowGroupValue(group.Id, label, kind, known > 0 ? sum : null, known);
    }

    /// <summary>Every configured group's rolled-up value for this graph, skipping ids that are blank.</summary>
    public static IEnumerable<FlowGroupValue> Totals(FlowGraph graph, EnergyFlowConfig flow)
        => (flow.Groups ?? new())
            .Where(g => !string.IsNullOrWhiteSpace(g.Id))
            .Select(g => Total(graph, g));
}
