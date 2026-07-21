namespace rPDU2MQTT.Grains.Abstractions.Cluster;

/// <summary>
/// Cluster-wide leader election (singleton, key 0) — the enabler for homogeneous silos. Every instance is
/// identical and scales by replica count; the "run once cluster-wide" work (the publishers/exporters) runs
/// only on the leader. Each silo renews a short lease on a timer; if the leader stops renewing, another silo
/// takes over automatically. Replaces the static worker/api/ui role split for that work.
/// </summary>
public interface ILeaderGrain : IGrainWithIntegerKey
{
    /// <summary>Grant or renew leadership to <paramref name="candidateId"/>. True if it is now the leader.</summary>
    Task<bool> Renew(string candidateId, int leaseSeconds);

    /// <summary>The current leader's id (null if the lease has expired) — for diagnostics.</summary>
    Task<string?> CurrentLeader();
}
