namespace rPDU2MQTT.Core.Integrations;

/// <summary>
/// "Exactly one process in the cluster owns this key." The one piece of distributed coordination an
/// integration is ever allowed to need, expressed without naming the thing that provides it.
///
/// <para>
/// It exists for a real constraint, not a theoretical one: many RS485-to-Ethernet gateways accept a single
/// TCP client, so every replica polling one independently causes the reads to time out. A PDU session and
/// the EmonCMS feed writer have the same shape — one owner, cluster-wide.
/// </para>
/// <para>
/// One process owns everything it can see (<see cref="SoleOwnerLease"/>), and an integration must never
/// know that. <c>LeaderState</c> is the same arrangement: a plain flag in Core, kept true by the host, read
/// by Engine code that has no idea what supplies it. Keeping the seam here is what keeps the
/// coordination decision open — nothing is persisted behind it, so replacing it would be a
/// coordination swap rather than a state migration.
/// </para>
/// </summary>
public interface ISingleOwnerLease
{
    /// <summary>
    /// Run <paramref name="work"/> only if this process owns <paramref name="key"/>, and return whether it
    /// did. A caller that gets false has not failed — another process is doing the work.
    /// </summary>
    Task<bool> RunIfOwnerAsync(string key, Func<CancellationToken, Task> work, CancellationToken ct);
}

/// <summary>
/// The single-process answer: this process owns everything, because it is the only one.
///
/// <para>
/// Correct for the shipped default (<c>split.enabled: false</c>, <c>replicaCount: 1</c>) and for every
/// test, and it means a test never needs a cluster to exercise an integration that declares ownership.
/// </para>
/// </summary>
public sealed class SoleOwnerLease : ISingleOwnerLease
{
    public async Task<bool> RunIfOwnerAsync(string key, Func<CancellationToken, Task> work, CancellationToken ct)
    {
        await work(ct);
        return true;
    }
}
