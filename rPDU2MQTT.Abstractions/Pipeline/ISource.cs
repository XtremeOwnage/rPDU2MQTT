namespace rPDU2MQTT.Abstractions.Pipeline;

/// <summary>
/// A producer of snapshots (a PDU, a Modbus device, an MQTT topic ingest, a CT clamp). A source <b>pushes</b>
/// — it captures on its own cadence (polled internally, or event-driven) and emits snapshots into the sink
/// it was given. It is never polled by the middleware, and it knows nothing about the middleware or any
/// destination. How it captures (poll vs subscribe) is an implementation detail this contract hides.
/// </summary>
/// <typeparam name="T">The snapshot type this source emits.</typeparam>
public interface ISource<out T> where T : ISnapshot
{
    /// <summary>Stable id; matches <see cref="ISnapshot.SourceId"/> on everything it emits.</summary>
    string Id { get; }

    /// <summary>Human-readable description for diagnostics.</summary>
    string Description { get; }

    /// <summary>
    /// Begin producing into <paramref name="sink"/>. Returns when the source has stopped (cancellation).
    /// The source owns its cadence and any device connection; the sink owns fan-out. A source implementation
    /// takes an <see cref="ISnapshotSink{T}"/> of its own <typeparamref name="T"/> — see the covariance note
    /// on <see cref="ISourceHost{T}"/> for why this method lives on the host, not here.
    /// </summary>
    // (RunAsync intentionally lives on ISourceHost<T> below to keep ISource<out T> covariant.)
}

/// <summary>
/// The runnable side of a source: given a sink, produce until cancelled. Kept separate from
/// <see cref="ISource{T}"/> so the descriptive interface can stay covariant (usable as
/// <c>ISource&lt;ISnapshot&gt;</c> in registries) while the run method — which consumes a
/// <c>sink</c> of the exact <typeparamref name="T"/> — stays invariant.
/// </summary>
public interface ISourceHost<T> : ISource<T> where T : ISnapshot
{
    /// <summary>Produce snapshots into <paramref name="sink"/> until <paramref name="cancellationToken"/> fires.</summary>
    Task RunAsync(ISnapshotSink<T> sink, CancellationToken cancellationToken);
}
