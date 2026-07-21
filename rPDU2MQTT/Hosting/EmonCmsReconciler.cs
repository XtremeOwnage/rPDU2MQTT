using Microsoft.Extensions.Hosting;
using Orleans;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Grains.Abstractions.EmonCms;

namespace rPDU2MQTT.Hosting;

/// <summary>
/// Pokes the EmonCMS feed grain on a timer (v3), replacing the in-process provisioner that had to be
/// leader-gated to avoid two workers provisioning at once. Every worker can poke: the grain is a single
/// activation, so "once cluster-wide" is structural rather than a check that can be wrong, and the grain
/// itself decides whether enough time has passed to be worth an API call.
/// </summary>
public sealed class EmonCmsReconciler : BackgroundService
{
    private readonly IGrainFactory grains;
    private readonly Config config;

    public EmonCmsReconciler(IGrainFactory grains, Config config)
    {
        this.grains = grains;
        this.config = config;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try { await Task.Delay(TimeSpan.FromSeconds(20), stoppingToken); } catch (OperationCanceledException) { return; }

        // Feed topology changes rarely; the grain throttles anyway. Read config each tick so enabling it in
        // the GUI takes effect without a restart.
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(60));
        do
        {
            var e = config.EmonCMS;
            if (!e.Enabled || !e.Feeds.AutoConfigure) continue;

            try { await grains.GetGrain<IEmonCmsFeedGrain>(0).Reconcile(force: false); }
            catch (Exception ex) { Serilog.Log.Debug($"EmonCMS reconciler: {ex.Message}"); }
        }
        while (await SafeWait(timer, stoppingToken));
    }

    private static async Task<bool> SafeWait(PeriodicTimer timer, CancellationToken ct)
    {
        try { return await timer.WaitForNextTickAsync(ct); }
        catch (OperationCanceledException) { return false; }
    }
}
