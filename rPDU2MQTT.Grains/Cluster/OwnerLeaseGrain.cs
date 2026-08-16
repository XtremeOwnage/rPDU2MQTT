using rPDU2MQTT.Grains.Abstractions.Cluster;

namespace rPDU2MQTT.Grains.Cluster;

/// <summary>
/// Ownership of one key, held on a short lease. Single-activation, so the decision is made in one place
/// cluster-wide however many instances ask.
/// </summary>
public sealed class OwnerLeaseGrain : Grain, IOwnerLeaseGrain
{
    private string? owner;
    private DateTime expiresUtc = DateTime.MinValue;

    public Task<bool> Claim(string candidateId, int leaseSeconds)
    {
        var now = DateTime.UtcNow;

        // A lapsed lease is up for grabs; an unexpired one belongs to whoever holds it. The holder renewing
        // is the common case and must be cheap — this runs on every poll of every owned device.
        if (owner is null || now >= expiresUtc || owner == candidateId)
        {
            owner = candidateId;
            expiresUtc = now.AddSeconds(Math.Max(1, leaseSeconds));
            return Task.FromResult(true);
        }

        return Task.FromResult(false);
    }

    public Task<string?> CurrentOwner()
        => Task.FromResult(DateTime.UtcNow < expiresUtc ? owner : null);
}
