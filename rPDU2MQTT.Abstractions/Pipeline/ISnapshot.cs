namespace rPDU2MQTT.Abstractions.Pipeline;

/// <summary>
/// The unit of data that crosses every seam of the pipeline (source → middleware → destination). A snapshot
/// is an <b>immutable, point-in-time</b> capture from one producer. It is the only shape that moves between
/// layers, so nothing has to hold a reference to another layer's concrete types.
/// <para>
/// <see cref="Version"/> is monotonic <b>per <see cref="SourceId"/></b>. Because delivery across processes
/// (grains/silos) is not ordered, a consumer keeps the highest version it has seen per source and discards
/// anything older or equal — making fan-out safe and idempotent. Two identical snapshots are
/// indistinguishable, so a source may re-emit freely.
/// </para>
/// </summary>
public interface ISnapshot
{
    /// <summary>Stable id of the producer this snapshot came from (device id, node id, "flow", …).</summary>
    string SourceId { get; }

    /// <summary>When the producer captured this snapshot (UTC).</summary>
    DateTimeOffset TimestampUtc { get; }

    /// <summary>Monotonic sequence for <see cref="SourceId"/>; consumers drop lower-or-equal as stale.</summary>
    long Version { get; }
}
