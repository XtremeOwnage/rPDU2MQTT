using Microsoft.Extensions.Hosting;
using Orleans;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Grains.Abstractions.Operator;

namespace rPDU2MQTT.Hosting;

/// <summary>
/// Drives the operator grain's periodic update check (v3). Calls route to the single cluster-wide activation,
/// which throttles to Operator.CheckIntervalHours — so this just needs to poke it often enough. Replaces the
/// OperatorService hosted loop; the GUI's "check now" / switch / redeploy are direct grain calls.
/// </summary>
public sealed class OperatorActivator : BackgroundService
{
    private readonly IGrainFactory grains;
    private readonly Config config;

    public OperatorActivator(IGrainFactory grains, Config config)
    {
        this.grains = grains;
        this.config = config;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try { await Task.Delay(TimeSpan.FromSeconds(20), stoppingToken); } catch (OperationCanceledException) { return; }

        using var timer = new PeriodicTimer(TimeSpan.FromMinutes(5));
        do
        {
            if (config.Operator.Enabled && config.Operator.CheckForUpdates)
            {
                try { await grains.GetGrain<IOperatorGrain>(0).CheckNow(force: false); }
                catch (Exception ex) { Serilog.Log.Debug($"Operator activator: {ex.Message}"); }
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
