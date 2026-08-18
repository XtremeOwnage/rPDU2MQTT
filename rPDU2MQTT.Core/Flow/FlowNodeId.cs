namespace rPDU2MQTT.Core.Flow;

/// <summary>
/// The one spelling of a derived node's id.
///
/// <para>
/// A PDU and its outlets appear on the flow graph as <c>pdu:{device}</c> and <c>outlet:{device}:{key}</c>,
/// and eight places used to build those strings for themselves — the graph builder, the exporters, the
/// aggregation service, the discovery map, the status reporter. Two of them disagreed about the outlet
/// index: the builder keys on <c>outlet.Key</c> (0-based) while a reading carries <c>Number</c> (1-based),
/// so every caller holding a reading had to remember to subtract one. Getting that wrong produces no error
/// — the lookup simply misses, and a hierarchy label silently comes back empty.
/// </para>
/// <para>
/// One function per id shape, and the reading carries its own (see <c>MeasurementReading.NodeId</c>), so
/// nothing downstream has to reconstruct it at all.
/// </para>
/// </summary>
public static class FlowNodeId
{
    /// <summary>The node id of a PDU tier.</summary>
    public static string ForPdu(string deviceName) => $"pdu:{deviceName}";

    /// <summary>The node id of an outlet, from its <b>0-based</b> key as the device reports it.</summary>
    public static string ForOutlet(string deviceName, int outletKey) => $"outlet:{deviceName}:{outletKey}";

    /// <summary>
    /// The node id of an outlet from its <b>1-based</b> number, as a flattened reading carries it. Separate
    /// from <see cref="ForOutlet"/> so the conversion happens once, here, instead of at every call site.
    /// </summary>
    public static string ForOutletNumber(string deviceName, int outletNumber) => ForOutlet(deviceName, outletNumber - 1);

    /// <summary>Is this one of the ids derived from a polled device, rather than a configured node?</summary>
    public static bool IsDerived(string? nodeId)
        => nodeId is not null
           && (nodeId.StartsWith("pdu:", StringComparison.OrdinalIgnoreCase)
               || nodeId.StartsWith("outlet:", StringComparison.OrdinalIgnoreCase));
}
