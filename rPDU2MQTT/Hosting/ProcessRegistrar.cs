using Microsoft.Extensions.Hosting;
using rPDU2MQTT.Core;
using rPDU2MQTT.Core.Diagnostics;
using rPDU2MQTT.Core.Integrations;
using rPDU2MQTT.Helpers;
using rPDU2MQTT.Services;

namespace rPDU2MQTT.Hosting;

/// <summary>
/// Registers this process with the <see cref="ProcessRegistry"/> on a timer, replacing the MQTT
/// <c>HeartbeatService</c> beacons, with roles and per-integration outcomes.
/// </summary>
public sealed class ProcessRegistrar : BackgroundService
{
    private readonly Core.Diagnostics.ProcessRegistry registry;
    private readonly IntegrationStatus status;
    private readonly ProcessInfo baseInfo;

    public ProcessRegistrar(IntegrationStatus status, ProcessIdentity self, Core.Diagnostics.ProcessRegistry? processRegistry = null)
    {
        registry = processRegistry ?? new Core.Diagnostics.ProcessRegistry();
        this.status = status;

        baseInfo = new ProcessInfo
        {
            Id = self.Id,
            Roles = self.Roles,
            Host = self.Host,
            StartedUtc = self.StartedUtc,
            Version = self.Version,
        };
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try { await Task.Delay(TimeSpan.FromSeconds(3), stoppingToken); } catch (OperationCanceledException) { return; }

        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(15));
        do
        {
            var info = baseInfo with { TimestampUtc = DateTime.UtcNow, Integrations = IntegrationReports.Local(status) };
            try { registry.Register(info); }
            catch (Exception ex) { Serilog.Log.Debug($"Process registrar: {ex.Message}"); }
        }
        while (await Core.Ticks.Next(timer, stoppingToken));
    }
}
