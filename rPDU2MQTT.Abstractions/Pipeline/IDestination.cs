namespace rPDU2MQTT.Abstractions.Pipeline;

/// <summary>
/// A sink to an external system — MQTT/Home Assistant, Prometheus, EmonCMS. A destination <b>consumes</b>
/// snapshots and pushes them onward; it is driven by the pipeline (subscribed to a feed and handed each
/// snapshot), it never polls a source. It may consume the middleware's mapped flow snapshots, the raw
/// source snapshots, or both — a destination that only needs raw device metrics doesn't route through the
/// flow engine at all.
/// </summary>
/// <typeparam name="T">The snapshot type this destination accepts.</typeparam>
public interface IDestination<in T> where T : ISnapshot
{
    /// <summary>Stable id for diagnostics.</summary>
    string Id { get; }

    /// <summary>
    /// Push one snapshot to the external system. Each destination is driven independently, so a slow push
    /// here (e.g. an HTTP call) must not be allowed to stall the middleware or other destinations — the
    /// driver isolates back-pressure per destination.
    /// </summary>
    ValueTask PushAsync(T snapshot, CancellationToken cancellationToken = default);
}
