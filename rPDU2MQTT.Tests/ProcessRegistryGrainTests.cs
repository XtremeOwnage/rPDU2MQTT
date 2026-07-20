using rPDU2MQTT.Grains.Abstractions.Diagnostics;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>The process registry grain (replacing the MQTT heartbeat): processes register and are listed back.</summary>
public class ProcessRegistryGrainTests
{
    [Fact]
    public async Task Register_Then_Active_ListsProcesses()
    {
        var cluster = await GrainTestCluster.StartAsync();
        try
        {
            var reg = cluster.GrainFactory.GetGrain<IProcessRegistryGrain>(0);
            await reg.Register(new ProcessInfo { Id = "worker-x", Roles = new[] { "worker" }, Host = "h", TimestampUtc = DateTime.UtcNow, EmonCms = new EmonCmsReport { Ok = true, Count = 3 } });
            await reg.Register(new ProcessInfo { Id = "ui-x", Roles = new[] { "ui" }, Host = "h", TimestampUtc = DateTime.UtcNow });

            var active = await reg.Active();
            Assert.Equal(2, active.Count);
            var worker = Assert.Single(active, p => p.Id == "worker-x");
            Assert.Equal(3, worker.EmonCms!.Count);   // EmonCmsReport survives the grain boundary
        }
        finally { await cluster.StopAllSilosAsync(); }
    }
}
