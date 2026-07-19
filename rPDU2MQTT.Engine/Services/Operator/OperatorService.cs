using k8s;
using k8s.Autorest;
using k8s.Models;
using Microsoft.Extensions.Hosting;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Startup.ConfigSources;
using rPDU2MQTT.Updates;

namespace rPDU2MQTT.Services.Operator;

/// <summary>
/// The Kubernetes operator (#210): periodically asks the container registry whether a newer release than
/// the one deployed exists, reports it on the CR <c>status</c> (visible via <c>kubectl get rpduconfig</c>
/// and the GUI Diagnostics page), and — only when <see cref="OperatorConfig.AutoUpdate"/> is on — rolls
/// this release's Deployment(s) to the newest eligible tag. Runs in the <c>operator</c> role with the
/// Kubernetes config source; a no-op otherwise.
/// </summary>
public sealed class OperatorService : IHostedService, IDisposable
{
    private readonly KubernetesConfigSource source;
    private readonly Config cfg;
    private readonly IContainerRegistry registry;
    private readonly CancellationTokenSource stoppingCts = new();
    private Task loop = Task.CompletedTask;

    // Container images this app publishes; used to pick the right container(s) to read/patch in a pod spec.
    private const string ContainerName = "rpdu2mqtt";

    public OperatorService(KubernetesConfigSource source, Config cfg, IContainerRegistry registry)
    {
        this.source = source;
        this.cfg = cfg;
        this.registry = registry;
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        loop = RunAsync(stoppingCts.Token);
        return Task.CompletedTask;
    }

    private async Task RunAsync(CancellationToken ct)
    {
        // Small initial delay so the pod is settled and the API is reachable before the first check.
        try { await Task.Delay(TimeSpan.FromSeconds(20), ct); } catch (OperationCanceledException) { return; }

        while (!ct.IsCancellationRequested)
        {
            if (cfg.Operator.Enabled && cfg.Operator.CheckForUpdates)
            {
                try { await CheckOnceAsync(ct); }
                catch (OperationCanceledException) { break; }
                catch (Exception ex) { Log.Warning($"Operator: update check failed: {ex.Message}"); }
            }

            var hours = Math.Max(1, cfg.Operator.CheckIntervalHours);
            try { await Task.Delay(TimeSpan.FromHours(hours), ct); }
            catch (OperationCanceledException) { break; }
        }
    }

    private async Task CheckOnceAsync(CancellationToken ct)
    {
        var deployedImage = Environment.GetEnvironmentVariable("RPDU2MQTT_IMAGE");
        if (!ImageReference.TryParse(deployedImage, out var image))
        {
            Log.Debug($"Operator: can't determine the deployed image (RPDU2MQTT_IMAGE='{deployedImage}'); skipping update check.");
            return;
        }

        var registryHost = ResolveRegistryHost(image);
        var repository = cfg.Operator.Repository ?? image.Repository;

        var tags = await registry.ListTagsAsync(registryHost, repository, ct);
        var check = UpdateResolver.Resolve(image.Tag, tags, cfg.Operator.Policy);

        if (!check.Applicable)
        {
            Log.Debug($"Operator: deployed tag '{image.Tag}' isn't a release version (moving channel or digest); no version comparison.");
            await PatchUpdateStatusAsync(new
            {
                available = false,
                current = image.Tag,
                latest = (string?)null,
                policy = cfg.Operator.Policy.ToString(),
                checkedAt = DateTime.UtcNow.ToString("o"),
                message = "Deployed tag is not a release version; tracking a moving channel.",
            }, ct);
            return;
        }

        var current = check.Current!.ToString();
        var latest = check.Latest!.ToString();

        if (check.UpdateAvailable)
            Log.Information($"Operator: update available — deployed {current}, newest eligible {latest} (policy {cfg.Operator.Policy}).");
        else
            Log.Debug($"Operator: up to date — deployed {current} is the newest eligible ({cfg.Operator.Policy}).");

        string? applied = null;
        if (check.UpdateAvailable && cfg.Operator.AutoUpdate)
        {
            var newImage = image.WithTag(latest);
            var patched = await SetImageAsync(repository, newImage, ct);
            if (patched.Count > 0)
            {
                applied = latest;
                Log.Warning($"Operator: auto-update applied — rolled {string.Join(", ", patched)} to {newImage}.");
            }
        }

        await PatchUpdateStatusAsync(new
        {
            available = check.UpdateAvailable,
            current,
            latest,
            policy = cfg.Operator.Policy.ToString(),
            autoUpdate = cfg.Operator.AutoUpdate,
            applied,
            checkedAt = DateTime.UtcNow.ToString("o"),
            message = check.UpdateAvailable
                ? (applied is not null ? $"Auto-updated to {applied}." : $"Update available: {latest}.")
                : "Up to date.",
        }, ct);
    }

    private string ResolveRegistryHost(ImageReference image)
    {
        var registryName = cfg.Operator.Registry ?? image.Registry;
        return registryName == ImageReference.DefaultRegistry ? "registry-1.docker.io" : registryName;
    }

    private Task PatchUpdateStatusAsync(object update, CancellationToken ct) =>
        source.PatchStatusAsync(new { update }, ct);

    // --- Deployment access (this release's own Deployments, scoped by label) ---------------------

    /// <summary>Patch every managed Deployment's rpdu2mqtt container image to <paramref name="newImage"/>.</summary>
    private async Task<List<string>> SetImageAsync(string repository, string newImage, CancellationToken ct)
    {
        var patched = new List<string>();
        foreach (var d in await AppDeploymentsAsync(ct))
        {
            if (d.Metadata?.Name is not { } name) continue;
            var containers = d.Spec?.Template?.Spec?.Containers;
            if (containers is null) continue;

            // Patch the container(s) whose current image is this repository, so a sidecar is left alone.
            var targets = containers
                .Where(c => ImageReference.TryParse(c.Image, out var r) && r.Repository == repository)
                .Select(c => c.Name)
                .DefaultIfEmpty(ContainerName)
                .ToArray();

            var body = new V1Patch(
                System.Text.Json.JsonSerializer.Serialize(new
                {
                    spec = new { template = new { spec = new { containers = targets.Select(n => new { name = n, image = newImage }) } } }
                }),
                V1Patch.PatchType.StrategicMergePatch);
            await source.Client.AppsV1.PatchNamespacedDeploymentAsync(body, name, source.Namespace, cancellationToken: ct);
            patched.Add(name);
        }
        return patched;
    }

    private async Task<IList<V1Deployment>> AppDeploymentsAsync(CancellationToken ct)
    {
        var list = await source.Client.AppsV1.ListNamespacedDeploymentAsync(source.Namespace, labelSelector: await AppSelectorAsync(ct), cancellationToken: ct);
        return list.Items;
    }

    /// <summary>Label selector scoping to this release — read off this pod, else a sensible default.</summary>
    private async Task<string> AppSelectorAsync(CancellationToken ct)
    {
        var podName = Environment.GetEnvironmentVariable("RPDU2MQTT_POD_NAME");
        if (!string.IsNullOrEmpty(podName))
        {
            try
            {
                var labels = (await source.Client.CoreV1.ReadNamespacedPodAsync(podName, source.Namespace, cancellationToken: ct)).Metadata?.Labels;
                if (labels is not null)
                {
                    if (labels.TryGetValue("app.kubernetes.io/instance", out var inst) && !string.IsNullOrEmpty(inst)) return $"app.kubernetes.io/instance={inst}";
                    if (labels.TryGetValue("app.kubernetes.io/name", out var nm) && !string.IsNullOrEmpty(nm)) return $"app.kubernetes.io/name={nm}";
                }
            }
            catch (HttpOperationException) { /* fall through to the default */ }
        }
        return "app.kubernetes.io/name=rpdu2mqtt";
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        await stoppingCts.CancelAsync();
        await Task.WhenAny(loop, Task.Delay(Timeout.Infinite, cancellationToken));
    }

    public void Dispose() => stoppingCts.Dispose();
}
