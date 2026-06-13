using HiveMQtt.Client;
using Microsoft.Extensions.Hosting;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Startup.ConfigSources;

namespace rPDU2MQTT.Services.Kubernetes;

/// <summary>
/// Periodically patches the RpduConfig <c>status</c> subresource (connected / deviceCount / lastPoll)
/// so the bridge's health is visible via <c>kubectl get rpduconfig</c>.
/// </summary>
public sealed class KubernetesStatusService : IHostedService, IDisposable
{
    private readonly KubernetesConfigSource source;
    private readonly IHiveMQClient mqtt;
    private readonly PDU pdu;
    private readonly PeriodicTimer timer;
    private readonly CancellationTokenSource stoppingCts = new();
    private Task loop = Task.CompletedTask;

    public KubernetesStatusService(KubernetesConfigSource source, IHiveMQClient mqtt, PDU pdu, Config cfg)
    {
        this.source = source;
        this.mqtt = mqtt;
        this.pdu = pdu;
        timer = new PeriodicTimer(TimeSpan.FromSeconds(Math.Max(5, cfg.PDU.PollInterval)));
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        loop = RunAsync(stoppingCts.Token);
        return Task.CompletedTask;
    }

    private async Task RunAsync(CancellationToken ct)
    {
        do
        {
            try
            {
                int deviceCount = 0;
                try { deviceCount = (await pdu.GetRootData_Public(ct)).Devices?.Count ?? 0; }
                catch { /* report connectivity even if a poll fails */ }

                await source.PatchStatusAsync(new
                {
                    connected = mqtt.IsConnected(),
                    deviceCount,
                    lastPoll = DateTime.UtcNow.ToString("o"),
                    message = "OK",
                }, ct);
            }
            catch (OperationCanceledException) { break; }
            catch (Exception ex)
            {
                Log.Debug($"Failed to patch RpduConfig status: {ex.Message}");
            }
        }
        while (await SafeWaitAsync(ct));
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
