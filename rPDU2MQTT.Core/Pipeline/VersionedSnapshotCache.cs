using System.Collections.Concurrent;
using rPDU2MQTT.Abstractions.Pipeline;

namespace rPDU2MQTT.Core.Pipeline;

/// <summary>
/// Thread-safe <see cref="ISnapshotCache{T}"/> keeping the latest snapshot per source, rejecting anything
/// not strictly newer by <see cref="ISnapshot.Version"/>. This is the "current state" shield: readers query
/// it instead of the device, and out-of-order delivery (across grains/silos) can't regress the value.
/// </summary>
public sealed class VersionedSnapshotCache<T> : ISnapshotCache<T> where T : ISnapshot
{
    private readonly ConcurrentDictionary<string, T> latest = new(StringComparer.Ordinal);

    public T? Latest(string sourceId) => latest.TryGetValue(sourceId, out var s) ? s : default;

    public IReadOnlyCollection<T> All => latest.Values.ToArray();

    public bool Accept(T snapshot)
    {
        var accepted = false;
        latest.AddOrUpdate(snapshot.SourceId,
            _ => { accepted = true; return snapshot; },
            (_, current) =>
            {
                if (snapshot.Version > current.Version) { accepted = true; return snapshot; }
                return current;   // stale or duplicate — keep what we have
            });
        return accepted;
    }
}
