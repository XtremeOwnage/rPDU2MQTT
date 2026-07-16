using System.Text.Json;
using Microsoft.Extensions.Hosting;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core;
using rPDU2MQTT.Startup.ConfigSources;

namespace rPDU2MQTT.Services.Kubernetes;

/// <summary>
/// Watches the RpduConfig <c>spec</c> for changes. Most edits are applied live — the reloaded config is
/// copied into the shared singleton and the PDU instances reconciled — so the API/UI don't restart on
/// every save (#187) and pods stop bouncing through Completed (#192). The process is only restarted when a
/// setting that can't be re-read at runtime changed (broker connection, listen ports, GUI auth).
/// </summary>
public sealed class KubernetesConfigWatcher : IHostedService, IDisposable
{
    private readonly KubernetesConfigSource source;
    private readonly IHostApplicationLifetime lifetime;
    private readonly Config config;
    private readonly InstanceManager instances;
    private readonly HostRole roles;
    private readonly PeriodicTimer timer = new(TimeSpan.FromSeconds(30));
    private readonly CancellationTokenSource stoppingCts = new();
    private Task loop = Task.CompletedTask;
    private string? baselineSpec;

    public KubernetesConfigWatcher(KubernetesConfigSource source, IHostApplicationLifetime lifetime, Config config, InstanceManager instances, HostRole roles)
    {
        this.source = source;
        this.lifetime = lifetime;
        this.config = config;
        this.instances = instances;
        this.roles = roles;
    }

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        try { baselineSpec = await source.ReadSpecRawAsync(cancellationToken); }
        catch (Exception ex) { Log.Debug($"Config watcher could not read baseline spec: {ex.Message}"); }
        loop = RunAsync(stoppingCts.Token);
    }

    private async Task RunAsync(CancellationToken ct)
    {
        while (await SafeWaitAsync(ct))
        {
            try
            {
                var current = await source.ReadSpecRawAsync(ct);
                if (baselineSpec is null || string.Equals(current, baselineSpec, StringComparison.Ordinal))
                    continue;

                var reloaded = source.Load();
                if (RequiresRestart(config, reloaded))
                {
                    Log.Information("RpduConfig spec changed in a way that needs a restart (connection/ports/auth); restarting to apply it.");
                    lifetime.StopApplication();
                    return;
                }

                await ApplyLive(reloaded);
                baselineSpec = current;
                Log.Information("RpduConfig spec changed; applied live without a restart.");
            }
            catch (OperationCanceledException) { break; }
            catch (Exception ex) { Log.Warning($"Config watcher could not apply the change live ({ex.Message}); leaving the running config in place."); }
        }
    }

    /// <summary>Copy the live-readable sections into the shared config, and reconcile pollers on the worker.</summary>
    private async Task ApplyLive(Config reloaded)
    {
        config.Overrides = reloaded.Overrides;
        config.EnergyFlow = reloaded.EnergyFlow;
        config.EmonCMS = reloaded.EmonCMS;
        config.HASS = reloaded.HASS;
        config.Prometheus = reloaded.Prometheus;
        config.Debug = reloaded.Debug;
        config.Pdus = reloaded.Pdus;

        // The poller lives on the worker; reconcile there so added/removed/retuned PDUs take effect live.
        if (roles.HasFlag(HostRole.Worker))
            await instances.ReconcileAsync();
    }

    /// <summary>True when a setting that can only be applied at startup changed (broker/ports/auth).</summary>
    public static bool RequiresRestart(Config live, Config reloaded)
        => Critical(live) != Critical(reloaded);

    private static string Critical(Config c) => JsonSerializer.Serialize(new
    {
        c.MQTT.Connection,
        c.MQTT.ClientID,
        c.MQTT.KeepAlive,
        c.MQTT.LastWill,
        c.MQTT.ParentTopic,
        Pdu = c.Pdus.ToDictionary(p => p.Key, p => new { p.Value.Connection }),
        c.Gui,
        c.Api,
        HealthPort = c.Health.Port,
        HealthEnabled = c.Health.Enabled,
        PromPort = c.Prometheus.Port,
    });

    private async Task<bool> SafeWaitAsync(CancellationToken ct)
    {
        try { return await timer.WaitForNextTickAsync(ct); }
        catch (OperationCanceledException) { return false; }
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        await stoppingCts.CancelAsync();
        await Task.WhenAny(loop, Task.Delay(Timeout.Infinite, cancellationToken));
    }

    public void Dispose()
    {
        stoppingCts.Dispose();
        timer.Dispose();
    }
}
