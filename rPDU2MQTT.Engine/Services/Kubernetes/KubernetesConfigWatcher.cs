using System.Text.Json;
using Microsoft.Extensions.Hosting;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core;
using rPDU2MQTT.Startup.ConfigSources;

namespace rPDU2MQTT.Services.Kubernetes;

/// <summary>
/// Watches the RpduConfig <c>spec</c> for changes and applies them live — the reloaded config is copied
/// into the shared singleton, the MQTT client is re-pointed and the PDU instances reconciled — so the
/// API/UI don't restart on every save (#187) and pods stop bouncing through Completed (#192).
/// <para>
/// The only remaining restart is a change to a listening socket (GUI/API/health/metrics ports) or GUI
/// auth, which are bound once when the host is built.
/// </para>
/// </summary>
public sealed class KubernetesConfigWatcher : IHostedService, IDisposable
{
    private readonly KubernetesConfigSource source;
    private readonly IHostApplicationLifetime lifetime;
    private readonly Config config;
    private readonly InstanceManager instances;
    private readonly MqttReconfigurator mqtt;
    private readonly HostRole roles;
    private readonly PeriodicTimer timer = new(TimeSpan.FromSeconds(30));
    private readonly CancellationTokenSource stoppingCts = new();
    private Task loop = Task.CompletedTask;
    private string? baselineSpec;

    public KubernetesConfigWatcher(KubernetesConfigSource source, IHostApplicationLifetime lifetime, Config config, InstanceManager instances, MqttReconfigurator mqtt, HostRole roles)
    {
        this.source = source;
        this.lifetime = lifetime;
        this.config = config;
        this.instances = instances;
        this.mqtt = mqtt;
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
                    rPDU2MQTT.Core.SelfRestart.Mark("config change requiring a restart");   // #192
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
        config.MQTT = reloaded.MQTT;
        config.Operator = reloaded.Operator;

        // Re-point the broker connection in place rather than exiting to be restarted (#192).
        await mqtt.ApplyAsync(stoppingCts.Token);

        // The poller lives on the worker; reconcile there so added/removed/retuned PDUs take effect live.
        // This also covers a changed Connection on an existing instance — the factory rebuilds it.
        if (roles.HasFlag(HostRole.Worker))
            await instances.ReconcileAsync();
    }

    /// <summary>
    /// True when a setting that can only be applied at startup changed. All that remains is the listening
    /// sockets (GUI/API/health/metrics ports) and GUI auth, which are bound once when the host is built.
    /// Everything else is applied live (#192): the MQTT client is re-pointed, and every PDU instance —
    /// including the primary, which is re-pointed in place because DI pins its identity — is reconciled.
    /// </summary>
    public static bool RequiresRestart(Config live, Config reloaded)
        => Critical(live) != Critical(reloaded);

    private static string Critical(Config c) => JsonSerializer.Serialize(new
    {
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
