using System.Collections.Concurrent;
using Microsoft.Extensions.Hosting;

namespace rPDU2MQTT.Core;

/// <summary>Last-known snapshot per source, kept up to date from the bus.</summary>
public interface ISnapshotCache
{
    /// <summary>The most recently received snapshot from any source, or null if none yet.</summary>
    PduSnapshot? Latest { get; }

    /// <summary>The latest snapshot for a specific source instance, or null if none yet.</summary>
    PduSnapshot? Get(string instanceId);

    /// <summary>The latest snapshot for every source seen so far.</summary>
    IReadOnlyCollection<PduSnapshot> All { get; }
}

/// <summary>
/// First v2 bus consumer: subscribes to the snapshot stream and keeps the latest per source so the
/// API/GUI can serve last-known data without re-polling. (Phase 2 of docs/v2-architecture.md.)
/// </summary>
public sealed class SnapshotCache : BackgroundService, ISnapshotCache
{
    private readonly IAsyncEnumerable<PduSnapshot> stream;
    private readonly ConcurrentDictionary<string, PduSnapshot> byInstance = new(StringComparer.OrdinalIgnoreCase);
    private volatile PduSnapshot? latest;

    // Subscribe at construction so the buffer captures snapshots published before ExecuteAsync runs.
    public SnapshotCache(IMessageBus bus) => stream = bus.Subscribe();

    public PduSnapshot? Latest => latest;
    public PduSnapshot? Get(string instanceId) => byInstance.TryGetValue(instanceId, out var s) ? s : null;
    public IReadOnlyCollection<PduSnapshot> All => byInstance.Values.ToArray();

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (var snapshot in stream.WithCancellation(stoppingToken))
        {
            byInstance[snapshot.InstanceId] = snapshot;
            latest = snapshot;
        }
    }
}
