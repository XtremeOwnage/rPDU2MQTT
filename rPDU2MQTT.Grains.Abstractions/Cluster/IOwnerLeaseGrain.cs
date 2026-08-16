namespace rPDU2MQTT.Grains.Abstractions.Cluster;

/// <summary>
/// Cluster-wide ownership of one key — a device, a serial gateway, a remote system that tolerates a single
/// writer. The grain's key IS the resource, so ownership of one thing is decided in one place.
///
/// <para>
/// The same lease shape as <see cref="ILeaderGrain"/>, per key rather than per cluster. That distinction is
/// the point: leadership answers "which instance does the run-once work", while this answers "who owns THIS
/// gateway" — and a fleet can perfectly well have one leader and several devices owned by different
/// instances, which is exactly what you want when each is near its own hardware.
/// </para>
/// </summary>
public interface IOwnerLeaseGrain : IGrainWithStringKey
{
    /// <summary>Grant or renew ownership to <paramref name="candidateId"/>. True if it now owns the key.</summary>
    Task<bool> Claim(string candidateId, int leaseSeconds);

    /// <summary>Who owns it (null once the lease has expired) — for diagnostics.</summary>
    Task<string?> CurrentOwner();
}
