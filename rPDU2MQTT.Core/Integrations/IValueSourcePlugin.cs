using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Models.Config;

namespace rPDU2MQTT.Core.Integrations;

/// <summary>
/// An integration that supplies live values for flow nodes bound to <i>its</i> kind of source — a third
/// ingest alongside MQTT and Modbus: an HTTP endpoint polled on a timer, SNMP, a vendor's cloud API.
///
/// <para>
/// A node binds a metric to a source with <c>Type: &lt;your id&gt;</c>, and whatever else that source needs
/// goes in the binding's <see cref="EnergyFlowSource.Settings"/> bag. The built-in types keep their own
/// typed fields (<c>Topic</c>, <c>Register</c>, …) — moving those into the bag would migrate every existing
/// binding for no benefit to anyone already using them, and a migration that touches every node's wiring is
/// not something to do casually.
/// </para>
/// <para>
/// Values reach the flow through the existing <see cref="IFlowValueSource"/> seam, so a plugin source rolls
/// up, exports and appears in Home Assistant exactly as MQTT does — the graph builder needs no notion of
/// where a number came from, and never has.
/// </para>
/// </summary>
public interface IValueSourcePlugin : IFlowValueSource
{
    /// <summary>
    /// How a binding names this source in <c>Type</c>. Usually the integration's own id.
    /// </summary>
    string SourceType { get; }

    /// <summary>What to call it in the node editor's source-type dropdown ("HTTP endpoint").</summary>
    string SourceTypeLabel { get; }

    /// <summary>
    /// Take up the bindings that name this source and start supplying their values. Called at startup and
    /// again whenever the configuration changes, so adding a binding takes effect without a restart —
    /// exactly as the MQTT ingest reconciles its subscriptions.
    /// </summary>
    /// <param name="bindings">Every binding of this type, with the node id each belongs to.</param>
    Task ReconcileAsync(Config cfg, IReadOnlyList<SourceBinding> bindings, CancellationToken ct);
}

/// <summary>One node's binding to a plugin-supplied source.</summary>
/// <param name="NodeId">The flow node this value belongs to.</param>
/// <param name="Metric">Which measurement it supplies — the key the flow will ask for.</param>
/// <param name="Source">The binding itself, including its <see cref="EnergyFlowSource.Settings"/>.</param>
public sealed record SourceBinding(string NodeId, string Metric, EnergyFlowSource Source)
{
    /// <summary>A setting from the binding's open bag, or null when it was not given.</summary>
    public string? Setting(string name)
        => Source.Settings.TryGetValue(name, out var v) ? v?.ToString() : null;

    /// <summary>An integer setting, or <paramref name="fallback"/> when absent or unparseable.</summary>
    public int Int(string name, int fallback = 0)
        => int.TryParse(Setting(name), out var v) ? v : fallback;

    /// <summary>
    /// The key this binding's value is stored and read under, accounting for direction and accumulation —
    /// the same key the built-in ingests use, so a plugin's value is indistinguishable downstream.
    /// </summary>
    public string Key()
        => FlowMetricKey.For(FlowMetricKey.ForAccumulation(Source.Metric ?? "", Source.Accumulation), Source.Direction ?? "out");
}

/// <summary>Finding the bindings that belong to a given source type.</summary>
public static class SourceBindings
{
    /// <summary>
    /// Every binding in <paramref name="cfg"/> whose <c>Type</c> is <paramref name="sourceType"/>.
    /// </summary>
    public static IReadOnlyList<SourceBinding> For(Config cfg, string sourceType)
        => cfg.EnergyFlow.Nodes
            .Where(n => !string.IsNullOrEmpty(n.Id))
            .SelectMany(n => n.AllSources()
                .Where(s => string.Equals(s.Type, sourceType, StringComparison.OrdinalIgnoreCase))
                .Select(s => new SourceBinding(n.Id, s.Metric ?? "", s)))
            .ToList();
}
