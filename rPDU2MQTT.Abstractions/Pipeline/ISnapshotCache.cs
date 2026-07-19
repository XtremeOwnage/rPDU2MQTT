namespace rPDU2MQTT.Abstractions.Pipeline;

/// <summary>
/// Holds the latest snapshot per source — the "current state" shield that lets a consumer answer
/// "what is the value now?" <b>without</b> triggering any I/O. This is how repeat polling is avoided: a
/// device is polled on its own cadence into the cache; every reader (GUI, a late-joining destination, a
/// recompute) reads the cache, never the device.
/// <para>
/// Push moves data; the cache answers questions. A stream consumer typically writes each snapshot it
/// receives into a cache so both models are available.
/// </para>
/// </summary>
public interface ISnapshotCache<T> where T : ISnapshot
{
    /// <summary>The latest snapshot seen for <paramref name="sourceId"/>, or null if none yet.</summary>
    T? Latest(string sourceId);

    /// <summary>The latest snapshot for every source seen so far.</summary>
    IReadOnlyCollection<T> All { get; }

    /// <summary>
    /// Record a snapshot as the latest for its source, unless a newer (higher <see cref="ISnapshot.Version"/>)
    /// one is already held. Returns true if it was accepted (i.e. it was in fact newer).
    /// </summary>
    bool Accept(T snapshot);
}
