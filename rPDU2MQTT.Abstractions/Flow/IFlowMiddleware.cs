using rPDU2MQTT.Abstractions.Pipeline;

namespace rPDU2MQTT.Abstractions.Flow;

/// <summary>
/// The heart of the project: energy-flow mapping. It consumes measurement snapshots from every source,
/// holds the latest per <c>(node, metric)</c>, applies the graph topology (feeders/children, aggregation,
/// residual/untracked sharing), and produces <see cref="FlowSnapshot"/>s for the destinations.
/// <para>
/// The graph math is global (a feeder takes a share of what measured siblings don't cover), so it stays in
/// one place here — it is not distributed across per-node actors. Node <b>state</b> may be distributed;
/// node <b>computation</b> is centralized. The topology itself comes from configuration and is supplied by
/// the implementation; this contract is only about the data flowing through.
/// </para>
/// </summary>
public interface IFlowMiddleware
{
    /// <summary>
    /// Ingest one source's measurements. Readings supersede the node's fixed/derived value per metric and
    /// expire per <see cref="MeasurementReading.StaleAfterSeconds"/>. Idempotent and order-tolerant: an older
    /// <see cref="ISnapshot.Version"/> for a source is ignored.
    /// </summary>
    void Ingest(MeasurementSnapshot measurements);

    /// <summary>
    /// Compute and return the current mapped flow. Each call stamps a fresh monotonic
    /// <see cref="ISnapshot.Version"/> so downstream can dedupe. Pure with respect to ingested state — safe
    /// to call for a "current value" query without touching any source.
    /// </summary>
    FlowSnapshot Snapshot();

    /// <summary>
    /// Every fresh raw <c>(node, metric)</c> value currently held — the un-rolled-up leaf readings, for
    /// syncing out to each process's live-value source so local graph builds and exports read the same live
    /// data without each process polling the sources itself.
    /// </summary>
    IReadOnlyList<RawValue> RawValues();
}
