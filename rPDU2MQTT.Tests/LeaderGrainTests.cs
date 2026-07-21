using rPDU2MQTT.Grains.Abstractions.Cluster;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// Cluster-leadership election: exactly one candidate holds the lease at a time (so the run-once
/// publishers/exporters don't duplicate across a homogeneous fleet), the incumbent keeps it by renewing, and
/// it fails over once the lease expires.
/// </summary>
public class LeaderGrainTests
{
    [Fact]
    public async Task Leader_IsExclusive_RenewsAndFailsOver()
    {
        var cluster = await GrainTestCluster.StartAsync();
        try
        {
            var leader = cluster.GrainFactory.GetGrain<ILeaderGrain>(0);

            // First candidate wins; a second is denied while the first holds a live lease.
            Assert.True(await leader.Renew("a", leaseSeconds: 2));
            Assert.False(await leader.Renew("b", leaseSeconds: 2));

            // The incumbent keeps it by renewing.
            Assert.True(await leader.Renew("a", leaseSeconds: 2));

            // After the lease expires, another candidate can take over.
            await Task.Delay(TimeSpan.FromSeconds(2.5));
            Assert.True(await leader.Renew("b", leaseSeconds: 2));
            Assert.False(await leader.Renew("a", leaseSeconds: 2));   // "a" is now the outsider
        }
        finally { await cluster.StopAllSilosAsync(); }
    }
}
