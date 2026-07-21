using Microsoft.Extensions.Hosting;
using rPDU2MQTT.Core;
using rPDU2MQTT.Startup.ConfigSources;

namespace rPDU2MQTT.Hosting;

/// <summary>
/// Restart by stopping: the only thing a process can do for itself when nothing is supervising it in a way
/// we can reach. Marks the intent so the host exits non-zero — see <see cref="SelfRestart"/> for why exit 0
/// is the wrong answer (#192).
/// </summary>
public sealed class StopProcessRestarter : IProcessRestarter
{
    private readonly IHostApplicationLifetime lifetime;

    public StopProcessRestarter(IHostApplicationLifetime lifetime) => this.lifetime = lifetime;

    public Task<string> RestartAsync(string reason, CancellationToken cancellationToken = default)
    {
        Serilog.Log.Warning("Restart requested ({Reason}); stopping this process so it can be started again.", reason);
        SelfRestart.Mark(reason);

        // Give the caller's response (and any in-flight publish) a moment to land before the host tears down.
        _ = Task.Run(async () =>
        {
            await Task.Delay(400);
            lifetime.StopApplication();
        });

        return Task.FromResult("Restarting this process…");
    }
}

/// <summary>
/// Restart under Kubernetes by asking the orchestrator to replace this pod (#192).
/// <para>
/// Deleting the pod gets a <i>new</i> one from the ReplicaSet straight away. Stopping the process instead
/// gets the same pod restarted on the kubelet's exponential backoff — which climbs to five minutes, and
/// leaves the old pod sitting in <c>Completed</c> looking like it finished on purpose. If the delete is
/// refused (no RBAC, no pod name), fall back to stopping rather than doing nothing.
/// </para>
/// </summary>
public sealed class KubernetesPodRestarter : IProcessRestarter
{
    private readonly KubernetesConfigSource kubernetes;
    private readonly StopProcessRestarter fallback;

    public KubernetesPodRestarter(KubernetesConfigSource kubernetes, StopProcessRestarter fallback)
    {
        this.kubernetes = kubernetes;
        this.fallback = fallback;
    }

    public async Task<string> RestartAsync(string reason, CancellationToken cancellationToken = default)
    {
        var pod = Environment.GetEnvironmentVariable("RPDU2MQTT_POD_NAME");
        if (string.IsNullOrWhiteSpace(pod))
            return await fallback.RestartAsync(reason, cancellationToken);

        try
        {
            Serilog.Log.Warning("Restart requested ({Reason}); deleting pod {Namespace}/{Pod} so it is replaced immediately.",
                reason, kubernetes.Namespace, pod);

            await kubernetes.Client.CoreV1.DeleteNamespacedPodWithHttpMessagesAsync(pod, kubernetes.Namespace, cancellationToken: cancellationToken);
            return $"Deleting pod {pod}; Kubernetes will start a replacement.";
        }
        catch (Exception ex)
        {
            Serilog.Log.Warning(ex, "Could not delete pod {Pod} (RBAC?); falling back to stopping the process.", pod);
            return await fallback.RestartAsync(reason, cancellationToken);
        }
    }
}
