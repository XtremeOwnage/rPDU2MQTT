namespace rPDU2MQTT.Core;

/// <summary>
/// The v2 producer/consumer bus: source pollers <see cref="PublishAsync"/> snapshots; each consumer
/// <see cref="Subscribe"/>s and reads its own independent stream. This thin seam is the single point a
/// different backend (e.g. a distributed one) would re-implement; see docs/v2-architecture.md.
/// </summary>
public interface IMessageBus
{
    /// <summary>Publish a snapshot to every current subscriber.</summary>
    ValueTask PublishAsync(PduSnapshot snapshot, CancellationToken cancellationToken = default);

    /// <summary>
    /// Subscribe to the snapshot stream. Each call gets its own bounded buffer, so a slow consumer
    /// can't stall others (and drops its own oldest items under sustained back-pressure).
    /// </summary>
    IAsyncEnumerable<PduSnapshot> Subscribe(int capacity = 16, CancellationToken cancellationToken = default);
}
