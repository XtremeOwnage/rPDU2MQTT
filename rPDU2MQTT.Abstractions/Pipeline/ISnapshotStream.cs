namespace rPDU2MQTT.Abstractions.Pipeline;

/// <summary>
/// The write side of a snapshot stream. A <b>producer</b> depends only on this — it emits and knows nothing
/// about who (if anyone) is listening. Split from <see cref="ISnapshotFeed{T}"/> so a producer can never
/// reach a consumer or the transport.
/// </summary>
public interface ISnapshotSink<in T> where T : ISnapshot
{
    /// <summary>Emit a snapshot to whatever is subscribed. Non-blocking; a slow consumer must not stall the producer.</summary>
    ValueTask EmitAsync(T snapshot, CancellationToken cancellationToken = default);
}

/// <summary>
/// The read side of a snapshot stream. A <b>consumer</b> depends only on this. Each <see cref="Subscribe"/>
/// call gets its own independent, back-pressure-isolated stream, so one slow consumer can't affect another.
/// </summary>
public interface ISnapshotFeed<out T> where T : ISnapshot
{
    /// <summary>
    /// Subscribe to the stream. The returned sequence is this subscriber's alone; under sustained
    /// back-pressure it drops its own oldest items (bounded by <paramref name="capacity"/>) rather than
    /// blocking the producer.
    /// </summary>
    IAsyncEnumerable<T> Subscribe(int capacity = 16, CancellationToken cancellationToken = default);
}

/// <summary>
/// A full snapshot stream — both ends. The transport (in-process channel today; an Orleans stream tomorrow)
/// implements this; producers and consumers only ever see the one-sided interfaces above.
/// </summary>
public interface ISnapshotStream<T> : ISnapshotSink<T>, ISnapshotFeed<T> where T : ISnapshot;
