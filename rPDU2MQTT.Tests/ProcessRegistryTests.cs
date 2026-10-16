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
        registry.Register(new ProcessInfo { Id = "worker-x", Roles = ["worker"], Host = "h", TimestampUtc = DateTime.UtcNow, Integrations = new Dictionary<string, IntegrationReport> { ["emoncms"] = new() { Ok = true, Count = 3 } } });
        registry.Register(new ProcessInfo { Id = "ui-x", Roles = ["ui"], Host = "h", TimestampUtc = DateTime.UtcNow });

        var active = registry.Active();
        Assert.Equal(2, active.Count);
        var worker = Assert.Single(active, p => p.Id == "worker-x");
        Assert.Equal(3, worker.Integrations["emoncms"].Count);
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

    [Fact]
    public void Local_ListsOnlyWhatThisProcessAttempted()
    {
        var status = new rPDU2MQTT.Core.Integrations.IntegrationStatus();
        status.RecordSuccess("emoncms", 5);
        status.RecordFailure("prometheus", "refused");

        var local = IntegrationReports.Local(status);

        Assert.Equal(2, local.Count);
        Assert.True(local["emoncms"].Ok);
        Assert.Equal(5, local["emoncms"].Count);
        Assert.Equal("refused", local["prometheus"].LastError);
        Assert.Empty(IntegrationReports.Local(new rPDU2MQTT.Core.Integrations.IntegrationStatus()));
    }

    [Fact]
    public void Freshest_IgnoresStaleProcesses_AndThoseThatNeverRanIt()
    {
        var now = DateTime.UtcNow;
        ProcessInfo With(string id, DateTime at, int? count) => new()
        {
            Id = id, TimestampUtc = at,
            Integrations = count is { } c ? new Dictionary<string, IntegrationReport> { ["emoncms"] = new() { Ok = true, Count = c } }
                                          : new Dictionary<string, IntegrationReport>(),
        };

        var processes = new[] { With("stale", now.AddMinutes(-2), 9), With("worker", now.AddSeconds(-10), 4), With("ui", now, null) };

        Assert.Equal(4, IntegrationReports.Freshest(processes, "emoncms")!.Count);
        Assert.Null(IntegrationReports.Freshest(processes, "influx"));
    }
}
