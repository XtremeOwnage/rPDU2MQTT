using k8s;
using k8s.Autorest;
using k8s.Models;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Grains.Abstractions.Operator;
using rPDU2MQTT.Startup.ConfigSources;
using rPDU2MQTT.Services.Operator;
using rPDU2MQTT.Updates;

namespace rPDU2MQTT.Grains.Operator;

/// <summary>
/// The Kubernetes operator as a single-activation grain (#210). Ports the OperatorService logic; holds the
/// report in-grain (returned to callers, no CR-status polling) while still patching the CR status for
/// <c>kubectl</c>. Deploy actions are grain calls that return results. A no-op without the Kubernetes source.
/// </summary>
public sealed class OperatorGrain : Grain, IOperatorGrain
{
    private const string ContainerName = "rpdu2mqtt";

    private readonly Config cfg;
    private readonly IContainerRegistry registry;
    private readonly KubernetesConfigSource? source;
    private readonly ILogger<OperatorGrain> log;

    private OperatorReport report = new() { Message = "No check yet." };
    private DateTime lastCheckUtc = DateTime.MinValue;

    /// <param name="source">
    /// The Kubernetes config source, when this deployment has one — declared as an optional dependency
    /// rather than fished out of the container, so the grain's requirements are visible in its signature.
    /// Null outside Kubernetes, where the operator is a no-op.
    /// </param>
    public OperatorGrain(Config cfg, IContainerRegistry registry, ILogger<OperatorGrain> log, KubernetesConfigSource? source = null)
    {
        this.cfg = cfg;
        this.registry = registry;
        this.log = log;
        this.source = source;
    }

    public Task<OperatorReport> Status() => Task.FromResult(report);

    public async Task<OperatorReport> CheckNow(bool force)
    {
        if (source is null) return report = report with { Message = "Operator needs the Kubernetes config source.", Severity = OperatorSeverity.Info };
        if (!cfg.Operator.Enabled || !cfg.Operator.CheckForUpdates)
            return report = report with { Message = "Update checks are disabled (Operator.Enabled / CheckForUpdates).", Severity = OperatorSeverity.Info };

        var interval = TimeSpan.FromHours(Math.Max(1, cfg.Operator.CheckIntervalHours));
        if (!force && DateTime.UtcNow - lastCheckUtc < interval) return report;   // throttle unless forced
        lastCheckUtc = DateTime.UtcNow;

        try { await CheckOnceAsync(CancellationToken.None); }
        catch (Exception ex)
        {
            log.LogWarning("Operator: check failed: {Msg}", ex.Message);
            report = report with { CheckedAt = NowIso(), Message = $"Update check failed: {ex.Message}", Severity = OperatorSeverity.Error };
        }
        return report;
    }

    public async Task<string> SetTag(string tag)
    {
        if (source is null) return "Operator needs the Kubernetes config source.";
        tag = tag.Trim();
        if (!ImageReference.TryParse(Environment.GetEnvironmentVariable("RPDU2MQTT_IMAGE"), out var image))
            return "The deployed image is unknown.";
        var repository = cfg.Operator.Repository ?? image.Repository;
        var newImage = image.WithTag(tag);
        try
        {
            var patched = await SetImageAsync(repository, newImage, newImage, CancellationToken.None);
            await Report(report with { Available = false, Current = tag, Latest = tag, Applied = tag, CheckedAt = NowIso(), Message = $"Switched to {tag}.", Severity = OperatorSeverity.Ok });
            return $"Switching to {tag}: rolled {(patched.Count > 0 ? string.Join(", ", patched) : "no")} deployment(s).";
        }
        catch (Exception ex) { return $"Switch to {tag} failed: {ex.Message}"; }
    }

    public async Task<string> Redeploy()
    {
        if (source is null) return "Operator needs the Kubernetes config source.";
        if (!ImageReference.TryParse(Environment.GetEnvironmentVariable("RPDU2MQTT_IMAGE"), out var image) || string.IsNullOrEmpty(image.Tag))
            return "The deployed image has no tag to re-pull.";
        var registryHost = ResolveRegistryHost(image);
        var repository = cfg.Operator.Repository ?? image.Repository;
        try
        {
            var digest = await registry.ResolveDigestAsync(registryHost, repository, image.Tag, CancellationToken.None);
            var newImage = digest is not null ? Pinned(image, repository, digest) : image.WithTag(image.Tag);
            // Container image may carry the @digest to force the re-pull; RPDU2MQTT_IMAGE stays the clean tag.
            var patched = await SetImageAsync(repository, newImage, image.WithTag(image.Tag), CancellationToken.None);
            await Report(report with { Current = image.Tag, CheckedAt = NowIso(), Message = $"Redeploying {image.Tag}.", Severity = OperatorSeverity.Ok });
            return $"Force update: rolled {(patched.Count > 0 ? string.Join(", ", patched) : "no")} deployment(s) to {newImage}.";
        }
        catch (Exception ex) { return $"Redeploy failed: {ex.Message}"; }
    }

    // --- ported check logic ---

    private async Task CheckOnceAsync(CancellationToken ct)
    {
        if (!ImageReference.TryParse(Environment.GetEnvironmentVariable("RPDU2MQTT_IMAGE"), out var image))
        {
            await Report(report with { CheckedAt = NowIso(), Message = "Deployed image is unknown (RPDU2MQTT_IMAGE).", Severity = OperatorSeverity.Info });
            return;
        }

        var registryHost = ResolveRegistryHost(image);
        var repository = cfg.Operator.Repository ?? image.Repository;
        var tags = await registry.ListTagsAsync(registryHost, repository, ct);
        var check = UpdateResolver.Resolve(image.Tag, tags, cfg.Operator.Policy);

        if (!check.Applicable)
        {
            if (string.IsNullOrEmpty(image.Tag))
            {
                await Report(report with { CheckedAt = NowIso(), Message = "The deployed image has no tag to track.", Severity = OperatorSeverity.Info });
                return;
            }

            // A moving channel (unstable/edge/latest/stable) has no version to compare — but its digest moves
            // as new builds publish. Compare what the tag points to in the registry now against the digest
            // this process is actually running, so "Check now" can say a newer build is waiting instead of a
            // misleading "up to date". The two reads hit different services (registry vs the k8s API) and don't
            // depend on each other, so run them together.
            var digestTask = registry.ResolveDigestAsync(registryHost, repository, image.Tag, ct);
            var runningTask = RunningDigestAsync(ct);
            var registryDigest = await digestTask;
            var runningDigest = await runningTask;
            var newer = registryDigest is not null && runningDigest is not null && !ImageDigest.Equal(registryDigest, runningDigest);

            var (message, severity) = registryDigest is null
                ? ($"Tracking the moving '{image.Tag}' channel — couldn't read its digest from the registry.", OperatorSeverity.Info)
                : runningDigest is null
                    ? ($"Tracking the moving '{image.Tag}' channel — couldn't determine the running digest to compare.", OperatorSeverity.Info)
                    : newer
                        ? ($"A newer '{image.Tag}' build is available — use Force update to pull it.", OperatorSeverity.UpdateAvailable)
                        : ($"Running the latest '{image.Tag}' build.", OperatorSeverity.Ok);

            var appliedChannel = (string?)null;
            if (newer && cfg.Operator.AutoUpdate)
            {
                // AutoUpdate on a channel means "keep pulling its latest build": re-pull, pinning the digest.
                if ((await SetImageAsync(repository, Pinned(image, repository, registryDigest!), image.WithTag(image.Tag), ct)).Count > 0)
                {
                    appliedChannel = image.Tag;
                    message = $"A newer '{image.Tag}' build was available — auto-updated (rolling now).";
                }
            }

            await Report(report with
            {
                Available = newer,
                Current = image.Tag,
                Latest = image.Tag,
                Policy = cfg.Operator.Policy.ToString(),
                AutoUpdate = cfg.Operator.AutoUpdate,
                Applied = appliedChannel,
                CheckedAt = NowIso(),
                Message = message,
                Severity = severity,
            });
            return;
        }

        var current = check.Current!.ToString();
        var latest = check.Latest!.ToString();
        string? applied = null;
        if (check.UpdateAvailable && cfg.Operator.AutoUpdate)
        {
            var patched = await SetImageAsync(repository, image.WithTag(latest), image.WithTag(latest), ct);
            if (patched.Count > 0) applied = latest;
        }

        await Report(report with
        {
            Available = check.UpdateAvailable,
            Current = current,
            Latest = latest,
            Policy = cfg.Operator.Policy.ToString(),
            AutoUpdate = cfg.Operator.AutoUpdate,
            Applied = applied,
            CheckedAt = NowIso(),
            Message = check.UpdateAvailable ? (applied is not null ? $"Auto-updated to {applied}." : $"Update available: {latest}.") : "Up to date.",
            Severity = check.UpdateAvailable ? OperatorSeverity.UpdateAvailable : OperatorSeverity.Ok,
        });
    }

    /// <summary>A digest-pinned <c>registry/repo:tag@sha256:…</c> pull reference — honours the operator's
    /// repository override, so it can't use <see cref="ImageReference.ToString"/>.</summary>
    private static string Pinned(ImageReference image, string repository, string digest)
        => $"{image.Registry}/{repository}:{image.Tag}@{digest}";

    private string ResolveRegistryHost(ImageReference image)
    {
        var registryName = cfg.Operator.Registry ?? image.Registry;
        return registryName == ImageReference.DefaultRegistry ? "registry-1.docker.io" : registryName;
    }

    /// <summary>
    /// The image digest this process is actually running — from the operator pod's own container status
    /// (it runs the very image being tracked). Null when it can't be read; the caller then says so rather
    /// than guessing.
    /// </summary>
    private async Task<string?> RunningDigestAsync(CancellationToken ct)
    {
        var pod = Environment.GetEnvironmentVariable("RPDU2MQTT_POD_NAME");
        if (source is null || string.IsNullOrWhiteSpace(pod)) return null;
        try
        {
            var p = await source.Client.CoreV1.ReadNamespacedPodAsync(pod, source.Namespace, cancellationToken: ct);
            var imageId = p.Status?.ContainerStatuses?.FirstOrDefault(c => c.Name == ContainerName)?.ImageID
                       ?? p.Status?.ContainerStatuses?.FirstOrDefault()?.ImageID;
            return ImageDigest.Normalize(imageId);
        }
        catch (Exception ex) { log.LogDebug("Operator: could not read running digest: {Msg}", ex.Message); return null; }
    }

    /// <summary>Store the report in-grain and mirror it to the CR status for kubectl visibility.</summary>
    private async Task Report(OperatorReport r)
    {
        report = r;
        if (source is null) return;
        try
        {
            await source.PatchStatusAsync(new { update = new { available = r.Available, current = r.Current, latest = r.Latest, policy = r.Policy, autoUpdate = r.AutoUpdate, applied = r.Applied, checkedAt = r.CheckedAt, message = r.Message } }, CancellationToken.None);
        }
        catch (Exception ex) { log.LogDebug("Operator: CR status patch failed: {Msg}", ex.Message); }
    }

    /// <summary>
    /// Patch the app Deployments' container image (may carry a @digest for a forced re-pull) AND the
    /// <c>RPDU2MQTT_IMAGE</c> env to <paramref name="envImage"/> (the clean tag form). The app reports its
    /// deployed tag from that env — the GUI "Currently deployed" + diagnostics read it, not the live container
    /// image — so without also patching the env a switch rolls the pod but the app keeps reporting the old tag
    /// and the change looks like it didn't stick.
    /// </summary>
    private async Task<List<string>> SetImageAsync(string repository, string newImage, string envImage, CancellationToken ct)
    {
        var patched = new List<string>();
        foreach (var d in await AppDeploymentsAsync(ct))
        {
            if (d.Metadata?.Name is not { } name) continue;
            var containers = d.Spec?.Template?.Spec?.Containers;
            if (containers is null) continue;
            var targets = TargetContainers(containers, repository);
            // No container here runs the app, so this Deployment is not ours to touch. It used to fall back
            // to the conventional container name, and because a strategic-merge patch keyed on name CREATES
            // an entry that doesn't exist, that injected a whole rPDU2MQTT container into any Deployment
            // sharing the app's instance label — the chart's own Valkey among them, which then ran a
            // crash-looping bridge alongside the cache.
            if (targets.Length == 0) continue;

            var body = new V1Patch(BuildImagePatch(targets, newImage, envImage), V1Patch.PatchType.StrategicMergePatch);
            await source!.Client.AppsV1.PatchNamespacedDeploymentAsync(body, name, source.Namespace, cancellationToken: ct);
            patched.Add(name);
        }
        return patched;
    }

    /// <summary>
    /// The containers in a Deployment that actually run <paramref name="repository"/>. Empty means the
    /// Deployment isn't running the app at all and must be left alone — the label selector finds every
    /// Deployment in the release, which includes sidecar infrastructure like the Valkey cache.
    /// </summary>
    internal static string[] TargetContainers(IEnumerable<V1Container> containers, string repository)
        => containers
            .Where(c => ImageReference.TryParse(c.Image, out var r) && r.Repository == repository)
            .Select(c => c.Name)
            .ToArray();

    /// <summary>
    /// The strategic-merge patch body that sets each target container's image and its <c>RPDU2MQTT_IMAGE</c>
    /// env. Both list merges are by name (the strategic-merge patchMergeKey), so this updates only the named
    /// containers and only that one env var, leaving everything else untouched.
    /// </summary>
    internal static string BuildImagePatch(IEnumerable<string> containerNames, string newImage, string envImage)
        => System.Text.Json.JsonSerializer.Serialize(new { spec = new { template = new { spec = new { containers = containerNames.Select(n => new
        {
            name = n,
            image = newImage,
            env = new[] { new { name = "RPDU2MQTT_IMAGE", value = envImage } },
        }) } } } });

    private async Task<IList<V1Deployment>> AppDeploymentsAsync(CancellationToken ct)
    {
        var list = await source!.Client.AppsV1.ListNamespacedDeploymentAsync(source.Namespace, labelSelector: await AppSelectorAsync(ct), cancellationToken: ct);
        return list.Items;
    }

    private async Task<string> AppSelectorAsync(CancellationToken ct)
    {
        var podName = Environment.GetEnvironmentVariable("RPDU2MQTT_POD_NAME");
        if (!string.IsNullOrEmpty(podName))
        {
            try
            {
                var labels = (await source!.Client.CoreV1.ReadNamespacedPodAsync(podName, source.Namespace, cancellationToken: ct)).Metadata?.Labels;
                if (labels is not null)
                {
                    if (labels.TryGetValue("app.kubernetes.io/instance", out var inst) && !string.IsNullOrEmpty(inst)) return $"app.kubernetes.io/instance={inst}";
                    if (labels.TryGetValue("app.kubernetes.io/name", out var nm) && !string.IsNullOrEmpty(nm)) return $"app.kubernetes.io/name={nm}";
                }
            }
            catch (HttpOperationException) { /* default */ }
        }
        return "app.kubernetes.io/name=rpdu2mqtt";
    }

    private static string NowIso() => DateTime.UtcNow.ToString("o");
}
