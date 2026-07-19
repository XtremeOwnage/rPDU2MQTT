using Orleans.TestingHost;
using rPDU2MQTT.Grains.Abstractions.Diagnostics;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>Proves the silo comes up and grains activate/place — the v3 bring-up smoke (in-memory cluster).</summary>
public class OrleansSmokeTests
{
    [Fact]
    public async Task PingGrain_Activates_InTestCluster()
    {
        var cluster = new TestClusterBuilder(1).Build();
        await cluster.DeployAsync();
        try
        {
            var grain = cluster.GrainFactory.GetGrain<IPingGrain>("self");
            var reply = await grain.Ping();
            Assert.Contains("pong", reply);
        }
        finally
        {
            await cluster.StopAllSilosAsync();
        }
    }
}
