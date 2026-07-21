using Microsoft.Extensions.Hosting;
using Orleans;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Grains.Abstractions.Devices;

namespace rPDU2MQTT.Hosting;

/// <summary>
/// Drives the Modbus device grains (v3). On a timer it asks each configured connection's <see cref="IDeviceGrain"/>
/// to poll — the call routes to the single cluster-wide activation, which throttles to the connection's
/// interval and serializes concurrent callers, so the device is read exactly once per interval no matter how
/// many silos run this. Replaces the per-process <c>EnergyFlowModbusSourceService</c> poller that caused
/// single-client-gateway contention.
/// </summary>
public sealed class DeviceGrainActivator : BackgroundService
{
    private readonly IGrainFactory grains;
    private readonly Config config;

    public DeviceGrainActivator(IGrainFactory grains, Config config)
    {
        this.grains = grains;
        this.config = config;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Small settle so the silo is up before the first grain call.
        try { await Task.Delay(TimeSpan.FromSeconds(3), stoppingToken); } catch (OperationCanceledException) { return; }

        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(2));
        do
        {
            foreach (var conn in config.Modbus.Connections)
            {
                if (!conn.Enabled || string.IsNullOrWhiteSpace(conn.Id) || string.IsNullOrWhiteSpace(conn.Host)) continue;
                try { await grains.GetGrain<IDeviceGrain>(conn.Id).Poll(); }
                catch (Exception ex) { Serilog.Log.Debug($"Device activator: {conn.Id} poll failed: {ex.Message}"); }
            }
        }
        while (await SafeWait(timer, stoppingToken));
    }

    private static async Task<bool> SafeWait(PeriodicTimer timer, CancellationToken ct)
    {
        try { return await timer.WaitForNextTickAsync(ct); }
        catch (OperationCanceledException) { return false; }
    }
}
