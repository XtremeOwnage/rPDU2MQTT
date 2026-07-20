using rPDU2MQTT.Grains.Abstractions.Cluster;

namespace rPDU2MQTT.Grains.Cluster;

/// <summary>Holds the current leader + lease. First/expired caller wins; the incumbent keeps renewing.</summary>
public sealed class LeaderGrain : Grain, ILeaderGrain
{
    private string? leader;
    private DateTime expiresUtc;

    public Task<bool> Renew(string candidateId, int leaseSeconds)
    {
        var now = DateTime.UtcNow;
        if (leader is null || now >= expiresUtc || string.Equals(leader, candidateId, StringComparison.Ordinal))
        {
            leader = candidateId;
            expiresUtc = now.AddSeconds(Math.Max(2, leaseSeconds));
            return Task.FromResult(true);
        }
        return Task.FromResult(false);   // someone else holds a live lease
    }
}
