namespace rPDU2MQTT.Grains.Abstractions.Flow;

/// <summary>
/// One owner, cluster-wide, of whether each source declared as a daily counter has behaved like one
/// (singleton, key 0).
///
/// <para>
/// The verdict is a property of a source, not of a process. Held per ingest it was reached twice — the MQTT
/// and Modbus services each kept their own map — and written back over one shared record, so each service's
/// save erased the other's. Two replicas would have compounded it. Single activation is the answer the rest
/// of v3 uses for "exactly one of these", and it applies here for the same reason.
/// </para>
/// <para>
/// Only sources that make the claim reach this grain: an energy source declared <c>period</c>. Everything
/// else is decided in the ingest without a call, which keeps a per-message hot path off the grain.
/// </para>
/// </summary>
public interface IPeriodAuditGrain : IGrainWithIntegerKey
{
    /// <summary>
    /// Fold a reading in and say whether it may be published as the day's total.
    /// </summary>
    /// <param name="nodeId">The node the binding feeds.</param>
    /// <param name="source">The topic or register, as named to whoever has to fix it.</param>
    /// <param name="direction">out / in — a node's two legs are different quantities on one source.</param>
    Task<bool> Allow(string nodeId, string source, string? direction, string periodKey, double value);

    /// <summary>Every binding currently withheld, as (node, source, metric, reason).</summary>
    Task<List<(string Node, string Source, string Metric, string Reason)>> Withheld();
}
