namespace rPDU2MQTT.Core.Integrations;

/// <summary>Guarantees exactly one process in the cluster owns a given key.</summary>
public interface ISingleOwnerLease
{
    /// <summary>Runs <paramref name="work"/> only if this process owns <paramref name="key"/>; returns whether it ran.</summary>
    Task<bool> RunIfOwnerAsync(string key, Func<CancellationToken, Task> work, CancellationToken ct);
}

/// <summary>Single-process lease: this process owns every key.</summary>
public sealed class SoleOwnerLease : ISingleOwnerLease
{
    public async Task<bool> RunIfOwnerAsync(string key, Func<CancellationToken, Task> work, CancellationToken ct)
    {
        await work(ct);
        return true;
    }
}

/// <summary>An integration the host hands the cluster lease to before first use.</summary>
public interface ISingleOwnerLeaseUser
{
    void UseLease(ISingleOwnerLease lease);
}
