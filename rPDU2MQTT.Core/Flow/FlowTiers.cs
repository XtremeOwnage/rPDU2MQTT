using rPDU2MQTT.Classes;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Models.PDU;

namespace rPDU2MQTT.Core.Flow;

/// <summary>
/// The energy-hierarchy tiers a recording destination carries, and the metrics they are carried under.
///
/// <para>
/// Every destination that stores a series per node — Prometheus, EmonCMS, and the history reads built on
/// them — has to agree on which nodes exist, which metrics they are exported under, and which of them have
/// a value worth sending. When each destination worked that out for itself they drifted: the flow tiers
/// reached Prometheus and never reached EmonCMS at all, so a hierarchy that was fully modelled on the Flow
/// tab had no history behind it.
/// </para>
/// </summary>
public static class FlowTiers
{
    /// <summary>One tier's value for one metric, ready for a destination.</summary>
    public readonly record struct Reading(FlowNode Node, string Metric, string Units, double Value);

    /// <summary>
    /// The metrics a tier is exported under: live power, the lifetime energy counter, and the daily total.
    /// </summary>
    public static IReadOnlyList<string> Metrics(Config cfg)
    {
        var energy = string.IsNullOrWhiteSpace(cfg.HASS.EnergyDashboard.EnergyMeasurementType)
            ? "energy"
            : cfg.HASS.EnergyDashboard.EnergyMeasurementType;

        return new[] { FlowGraphBuilder.DefaultMetric, energy, EnergyPeriod.Metric }
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    /// <summary>One graph per exported metric, built from the same snapshot and the same live values.</summary>
    public static IReadOnlyList<(string Metric, FlowGraph Graph)> Graphs(
        PduData data, Config cfg, IFlowValueSource? live)
        => Metrics(cfg).Select(m => (m, FlowGraphBuilder.Build(data, cfg.EnergyFlow, m, live))).ToList();

    /// <summary>Is there any hierarchy at all to export — configured tiers, or PDUs to derive them from?</summary>
    public static bool Any(PduData data, Config cfg)
        => data.Devices.Count > 0 || cfg.EnergyFlow.Nodes.Count > 0;

    /// <summary>
    /// The tiers of one graph a destination may record: a determined value (unknown is not zero), a real
    /// node rather than one of the builder's own arithmetic placeholders, and allowed by the tag filter.
    /// </summary>
    public static IEnumerable<Reading> Of(FlowGraph graph, NodeTagFilter? filter)
    {
        foreach (var node in graph.Nodes)
        {
            // The unmetered remainder is arithmetic about a hierarchy, not a device.
            if (!FlowExport.ToMetricsStore(node)) continue;
            // Tag filter (#342): what this destination carries. Never changes a value.
            if (filter is not null && !filter.Allows(node.Tags)) continue;
            // Unknown is not zero.
            if (node.Value is not { } value) continue;

            yield return new Reading(node, graph.Metric, graph.Units, value);
        }
    }
}
