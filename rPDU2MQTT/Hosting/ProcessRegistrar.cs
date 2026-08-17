using Microsoft.Extensions.Hosting;
using rPDU2MQTT.Core;
using rPDU2MQTT.Core.Diagnostics;
using rPDU2MQTT.Helpers;
using rPDU2MQTT.Services;

namespace rPDU2MQTT.Hosting;

/// <summary>
/// Registers this process with the <see cref="ProcessRegistry"/> on a timer, replacing the MQTT
/// <c>HeartbeatService</c> beacons. Carries the process's roles + EmonCMS export status so the GUI Status
/// board lists every role process in a split deployment.
/// </summary>
public sealed class ProcessRegistrar : BackgroundService
{
    private readonly Core.Diagnostics.ProcessRegistry registry;
    private readonly EmonCmsStatus emon;
    private readonly ProcessInfo baseInfo;

    public ProcessRegistrar(EmonCmsStatus emon, ProcessIdentity self, Core.Diagnostics.ProcessRegistry? processRegistry = null)
    {
        registry = processRegistry ?? new Core.Diagnostics.ProcessRegistry();
        this.emon = emon;

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
            EmonCmsReport? emonReport = null;
            if (emon.HasAttempted)
            {
                var s = emon.Snapshot();
                emonReport = new EmonCmsReport { Ok = s.Ok, LastSuccessUtc = s.LastSuccessUtc, LastError = s.LastError, Count = s.Count };
            }

            var info = baseInfo with { TimestampUtc = DateTime.UtcNow, EmonCms = emonReport };
            try { registry.Register(info); }
            catch (Exception ex) { Serilog.Log.Debug($"Process registrar: {ex.Message}"); }
        }
        while (await Core.Ticks.Next(timer, stoppingToken));
    }
}
