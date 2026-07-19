using HiveMQtt.Client;
using HiveMQtt.Client.Events;
using HiveMQtt.MQTT5.Types;
using k8s;
using k8s.Autorest;
using k8s.Models;
using Microsoft.Extensions.Hosting;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core;
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
    private readonly HiveMQClient mqtt;
    private readonly CancellationTokenSource stoppingCts = new();
    // Released by a "check now" command so the loop runs a check immediately instead of waiting for the timer.
    private readonly SemaphoreSlim checkNow = new(0, 1);
    private Task loop = Task.CompletedTask;

    // Container images this app publishes; used to pick the right container(s) to read/patch in a pod spec.
    private const string ContainerName = "rpdu2mqtt";
    private static readonly System.Text.Json.JsonSerializerOptions Json = new(System.Text.Json.JsonSerializerDefaults.Web);

    public OperatorService(KubernetesConfigSource source, Config cfg, IContainerRegistry registry, IHiveMQClient mqtt)
    {
        this.source = source;
        this.cfg = cfg;
        this.registry = registry;
        this.mqtt = (HiveMQClient)mqtt;
    }

    private string CommandTopic => OperatorCommand.TopicFor(cfg.MQTT.ParentTopic);

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        // Listen for "check now" requests the GUI publishes over the bus (it runs in a different process).
        mqtt.OnMessageReceived += OnMessageReceived;
        try { await mqtt.SubscribeAsync(CommandTopic, QualityOfService.AtLeastOnceDelivery); }
        catch (Exception ex) { Log.Warning($"Operator: could not subscribe to {CommandTopic}: {ex.Message}"); }
        loop = RunAsync(stoppingCts.Token);
    }

    private void OnMessageReceived(object? sender, OnMessageReceivedEventArgs e)
    {
        if (!string.Equals(e.PublishMessage.Topic, CommandTopic, StringComparison.Ordinal)) return;

        OperatorCommand? cmd;
        try { cmd = System.Text.Json.JsonSerializer.Deserialize<OperatorCommand>(e.PublishMessage.PayloadAsString ?? "", Json); }
        catch { return; }
        if (cmd is null) return;

        if (string.Equals(cmd.Action, OperatorCommand.SetTagAction, StringComparison.Ordinal) && !string.IsNullOrWhiteSpace(cmd.Tag))
        {
            Log.Information($"Operator: switch-to-tag '{cmd.Tag}' requested over the bus.");
            _ = Task.Run(() => SetTagAsync(cmd.Tag!.Trim(), stoppingCts.Token));
        }
        else
        {
            // "check now": wake the loop (ignore if a wake is already pending).
            Log.Information("Operator: on-demand update check requested over the bus.");
            try { checkNow.Release(); } catch (SemaphoreFullException) { /* a check is already pending */ }
        }
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

            // Wait for the interval, but wake early if a "check now" arrives.
            var hours = Math.Max(1, cfg.Operator.CheckIntervalHours);
            try { await checkNow.WaitAsync(TimeSpan.FromHours(hours), ct); }
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

    /// <summary>
    /// Roll the managed Deployment(s) to a chosen tag — a channel (<c>stable</c>/<c>edge</c>/<c>dev</c>) or a
    /// specific version — requested from the GUI. This is the manual counterpart to auto-update.
    /// </summary>
    private async Task SetTagAsync(string tag, CancellationToken ct)
    {
        var deployedImage = Environment.GetEnvironmentVariable("RPDU2MQTT_IMAGE");
        if (!ImageReference.TryParse(deployedImage, out var image))
        {
            Log.Warning($"Operator: can't switch tag — deployed image unknown (RPDU2MQTT_IMAGE='{deployedImage}').");
            return;
        }

        var repository = cfg.Operator.Repository ?? image.Repository;
        var newImage = image.WithTag(tag);

        // Report the intent before patching: switching may roll this operator's own pod, cutting the run short.
        await PatchUpdateStatusAsync(new
        {
            current = image.Tag,
            latest = tag,
            checkedAt = DateTime.UtcNow.ToString("o"),
            message = $"Switching to {tag}…",
        }, ct);

        try
        {
            var patched = await SetImageAsync(repository, newImage, ct);
            Log.Warning($"Operator: switched {(patched.Count > 0 ? string.Join(", ", patched) : "no")} deployment(s) to {newImage}.");
            await PatchUpdateStatusAsync(new
            {
                available = false,
                current = tag,
                latest = tag,
                applied = tag,
                checkedAt = DateTime.UtcNow.ToString("o"),
                message = $"Switched to {tag}.",
            }, ct);
        }
        catch (Exception ex)
        {
            Log.Error($"Operator: could not switch to {newImage}: {ex.Message}");
            try { await PatchUpdateStatusAsync(new { current = image.Tag, checkedAt = DateTime.UtcNow.ToString("o"), message = $"Switch to {tag} failed: {ex.Message}" }, ct); }
            catch { /* best effort */ }
        }
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
        mqtt.OnMessageReceived -= OnMessageReceived;
        await stoppingCts.CancelAsync();
        await Task.WhenAny(loop, Task.Delay(Timeout.Infinite, cancellationToken));
    }

    public void Dispose()
    {
        stoppingCts.Dispose();
        checkNow.Dispose();
    }
}
