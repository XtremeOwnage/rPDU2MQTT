using Microsoft.Extensions.Hosting;
using rPDU2MQTT.Startup.ConfigSources;

namespace rPDU2MQTT.Services.Kubernetes;

/// <summary>
/// Watches the RpduConfig <c>spec</c> for changes and restarts the application so the new config is
/// loaded (config is applied at startup; a restart is the simple, correct way to reload it).
/// </summary>
public sealed class KubernetesConfigWatcher : IHostedService, IDisposable
{
    private readonly KubernetesConfigSource source;
    private readonly IHostApplicationLifetime lifetime;
    private readonly PeriodicTimer timer = new(TimeSpan.FromSeconds(30));
    private readonly CancellationTokenSource stoppingCts = new();
    private Task loop = Task.CompletedTask;
    private string? baselineSpec;

    public KubernetesConfigWatcher(KubernetesConfigSource source, IHostApplicationLifetime lifetime)
    {
        this.source = source;
        this.lifetime = lifetime;
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
                if (baselineSpec is not null && !string.Equals(current, baselineSpec, StringComparison.Ordinal))
                {
                    Log.Information("RpduConfig spec changed; restarting to apply the new configuration.");
                    lifetime.StopApplication();
                    return;
                }
            }
            catch (OperationCanceledException) { break; }
            catch (Exception ex)
            {
                Log.Debug($"Config watcher poll failed: {ex.Message}");
            }
        }
    }

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
