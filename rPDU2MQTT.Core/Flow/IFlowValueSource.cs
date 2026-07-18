namespace rPDU2MQTT.Core.Flow;

/// <summary>
/// Supplies live leaf values for flow nodes that aren't derived from a PDU — the seam
/// <see cref="Models.Config.EnergyFlowNode.Value"/> always described: a node can bind to a real
/// measurement instead of a hand-entered figure. Implemented today by the MQTT ingest
/// (<c>EnergyFlowMqttSourceService</c>, e.g. Solar Assistant); CT clamps or an inverter API can plug in
/// the same way without touching <see cref="FlowGraphBuilder"/>.
/// </summary>
public interface IFlowValueSource
{
    /// <summary>
    /// The current value for <paramref name="nodeId"/> expressed in <paramref name="metric"/>
    /// (e.g. <c>realpower</c>, <c>energy</c>), or false when this source has nothing fresh for it.
    /// Values are per-metric, so a node can feed both the power and the energy roll-up from different topics.
    /// </summary>
    bool TryGetValue(string nodeId, string metric, out double value);
}
