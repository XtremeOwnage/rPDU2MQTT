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

    /// <summary>
    /// True when this source is the only authority on a node's value, so a reading from anywhere else — the
    /// device snapshot included — must not be used to fill a gap in it.
    ///
    /// <para>
    /// A point-in-time source sets this. Without it a view of "an hour ago" showed the stored value for
    /// every node the backend held, and the CURRENT reading for every node it did not, with nothing to tell
    /// them apart.
    /// </para>
    /// </summary>
    bool Exclusive => false;
}
