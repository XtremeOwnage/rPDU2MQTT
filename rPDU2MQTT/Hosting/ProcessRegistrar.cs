using Microsoft.Extensions.Hosting;
using Orleans;
using rPDU2MQTT.Core;
using rPDU2MQTT.Grains.Abstractions.Diagnostics;
using rPDU2MQTT.Helpers;
using rPDU2MQTT.Services;

namespace rPDU2MQTT.Hosting;

/// <summary>
/// Registers this process with the cluster-wide <see cref="IProcessRegistryGrain"/> on a timer (v3),
/// replacing the MQTT <c>HeartbeatService</c> beacons. Carries the process's roles + EmonCMS export status
/// so the GUI Status board lists every role process in a split deployment.
/// </summary>
public sealed class ProcessRegistrar : BackgroundService
{
    private readonly IGrainFactory grains;
    private readonly EmonCmsStatus emon;
    private readonly ProcessInfo baseInfo;

    public ProcessRegistrar(IGrainFactory grains, EmonCmsStatus emon, ProcessIdentity self)
    {
        this.grains = grains;
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
            try { await grains.GetGrain<IProcessRegistryGrain>(0).Register(info); }
            catch (Exception ex) { Serilog.Log.Debug($"Process registrar: {ex.Message}"); }
        }
        while (await SafeWait(timer, stoppingToken));
    }

    private static async Task<bool> SafeWait(PeriodicTimer timer, CancellationToken ct)
    {
        try { return await timer.WaitForNextTickAsync(ct); }
        catch (OperationCanceledException) { return false; }
    }
}
