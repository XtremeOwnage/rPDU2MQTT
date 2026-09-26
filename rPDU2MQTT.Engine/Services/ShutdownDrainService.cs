using Microsoft.Extensions.Hosting;

namespace rPDU2MQTT.Services;

/// <summary>
/// Keeps the GUI and API serving for a few seconds after SIGTERM (#506).
///
/// <para>
/// Kubernetes sends SIGTERM and takes the pod out of the Service's endpoints at the same time, and the
/// endpoints reach a gateway (kube-proxy, Envoy) a second or more later. A process that closed its listener
/// on SIGTERM was still being sent requests, and the gateway answered them with "upstream connect error …
/// connection refused" and a 503 in the middle of what was meant to be a graceful rollout.
/// </para>
/// <para>
/// Registered after the web hosts and before the leader lease, so shutdown runs: the lease is released
/// (the standby takes over producing), then this waits while the pages still answer, then they stop.
/// /readyz reports not-ready from SIGTERM on, which is what takes the pod out of rotation meanwhile.
/// </para>
/// </summary>
public sealed class ShutdownDrainService : IHostedService
{
    /// <summary>Seconds to keep serving after SIGTERM; 10 unless set.</summary>
    public const string SecondsVariable = "RPDU2MQTT_SHUTDOWN_DRAIN_SECONDS";

    private readonly TimeSpan drain;

    public ShutdownDrainService()
    {
        var s = int.TryParse(Environment.GetEnvironmentVariable(SecondsVariable), out var v) && v >= 0 ? v : 10;
        drain = TimeSpan.FromSeconds(s);
    }

    public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        if (drain <= TimeSpan.Zero) return;
        Log.Information($"Shutting down: still serving for {drain.TotalSeconds:0}s while the gateway stops routing here.");
        try { await Task.Delay(drain, cancellationToken); } catch (OperationCanceledException) { /* the host gave up waiting */ }
    }
}
