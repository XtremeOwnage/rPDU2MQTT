using rPDU2MQTT.Core.Diagnostics;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>The process registry (replacing the MQTT heartbeat): processes register and are listed back.</summary>
public class ProcessRegistryTests
{
    [Fact]
    public void Register_Then_Active_ListsProcesses()
    {
        var registry = new ProcessRegistry();
        registry.Register(new ProcessInfo { Id = "worker-x", Roles = ["worker"], Host = "h", TimestampUtc = DateTime.UtcNow, EmonCms = new EmonCmsReport { Ok = true, Count = 3 } });
        registry.Register(new ProcessInfo { Id = "ui-x", Roles = ["ui"], Host = "h", TimestampUtc = DateTime.UtcNow });

        var active = registry.Active();
        Assert.Equal(2, active.Count);
        var worker = Assert.Single(active, p => p.Id == "worker-x");
        Assert.Equal(3, worker.EmonCms!.Count);
    }

    [Fact]
    public void ALongGoneProcess_IsDropped_NotListedForever()
    {
        var registry = new ProcessRegistry();
        registry.Register(new ProcessInfo { Id = "old", Host = "h", TimestampUtc = DateTime.UtcNow.AddHours(-1) });
        registry.Register(new ProcessInfo { Id = "now", Host = "h", TimestampUtc = DateTime.UtcNow });

        Assert.Equal("now", Assert.Single(registry.Active()).Id);
    }

    [Fact]
    public void ReRegistering_ReplacesTheProcessesOwnReport()
    {
        var registry = new ProcessRegistry();
        registry.Register(new ProcessInfo { Id = "worker", TimestampUtc = DateTime.UtcNow.AddSeconds(-30) });
        registry.Register(new ProcessInfo { Id = "worker", TimestampUtc = DateTime.UtcNow, Version = "1.2.3" });

        Assert.Equal("1.2.3", Assert.Single(registry.Active()).Version);
    }
}
