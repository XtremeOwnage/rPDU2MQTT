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

    public OperatorGrain(Config cfg, IContainerRegistry registry, ILogger<OperatorGrain> log, IServiceProvider sp)
    {
        this.cfg = cfg;
        this.registry = registry;
        this.log = log;
        source = sp.GetService<KubernetesConfigSource>();
    }

    public Task<OperatorReport> Status() => Task.FromResult(report);

    public async Task<OperatorReport> CheckNow(bool force)
    {
        if (source is null) return report = report with { Message = "Operator needs the Kubernetes config source." };
        if (!cfg.Operator.Enabled || !cfg.Operator.CheckForUpdates)
            return report = report with { Message = "Update checks are disabled (Operator.Enabled / CheckForUpdates)." };

        var interval = TimeSpan.FromHours(Math.Max(1, cfg.Operator.CheckIntervalHours));
        if (!force && DateTime.UtcNow - lastCheckUtc < interval) return report;   // throttle unless forced
        lastCheckUtc = DateTime.UtcNow;

        try { await CheckOnceAsync(CancellationToken.None); }
        catch (Exception ex) { log.LogWarning("Operator: check failed: {Msg}", ex.Message); }
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
            var patched = await SetImageAsync(repository, newImage, CancellationToken.None);
            await Report(report with { Available = false, Current = tag, Latest = tag, Applied = tag, CheckedAt = NowIso(), Message = $"Switched to {tag}." });
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
            var newImage = digest is not null ? $"{image.Registry}/{repository}:{image.Tag}@{digest}" : image.WithTag(image.Tag);
            var patched = await SetImageAsync(repository, newImage, CancellationToken.None);
            await Report(report with { Current = image.Tag, CheckedAt = NowIso(), Message = $"Redeploying {image.Tag}." });
            return $"Force update: rolled {(patched.Count > 0 ? string.Join(", ", patched) : "no")} deployment(s) to {newImage}.";
        }
        catch (Exception ex) { return $"Redeploy failed: {ex.Message}"; }
    }

    // --- ported check logic ---

    private async Task CheckOnceAsync(CancellationToken ct)
    {
        if (!ImageReference.TryParse(Environment.GetEnvironmentVariable("RPDU2MQTT_IMAGE"), out var image))
        {
            await Report(report with { CheckedAt = NowIso(), Message = "Deployed image is unknown (RPDU2MQTT_IMAGE)." });
            return;
        }

        var registryHost = ResolveRegistryHost(image);
        var repository = cfg.Operator.Repository ?? image.Repository;
        var tags = await registry.ListTagsAsync(registryHost, repository, ct);
        var check = UpdateResolver.Resolve(image.Tag, tags, cfg.Operator.Policy);

        if (!check.Applicable)
        {
            await Report(report with { Available = false, Current = image.Tag, Latest = null, Policy = cfg.Operator.Policy.ToString(), CheckedAt = NowIso(), Message = "Deployed tag is not a release version; tracking a moving channel." });
            return;
        }

        var current = check.Current!.ToString();
        var latest = check.Latest!.ToString();
        string? applied = null;
        if (check.UpdateAvailable && cfg.Operator.AutoUpdate)
        {
            var patched = await SetImageAsync(repository, image.WithTag(latest), ct);
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
        });
    }

    private string ResolveRegistryHost(ImageReference image)
    {
        var registryName = cfg.Operator.Registry ?? image.Registry;
        return registryName == ImageReference.DefaultRegistry ? "registry-1.docker.io" : registryName;
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

    private async Task<List<string>> SetImageAsync(string repository, string newImage, CancellationToken ct)
    {
        var patched = new List<string>();
        foreach (var d in await AppDeploymentsAsync(ct))
        {
            if (d.Metadata?.Name is not { } name) continue;
            var containers = d.Spec?.Template?.Spec?.Containers;
            if (containers is null) continue;
            var targets = containers
                .Where(c => ImageReference.TryParse(c.Image, out var r) && r.Repository == repository)
                .Select(c => c.Name).DefaultIfEmpty(ContainerName).ToArray();
            var body = new V1Patch(
                System.Text.Json.JsonSerializer.Serialize(new { spec = new { template = new { spec = new { containers = targets.Select(n => new { name = n, image = newImage }) } } } }),
                V1Patch.PatchType.StrategicMergePatch);
            await source!.Client.AppsV1.PatchNamespacedDeploymentAsync(body, name, source.Namespace, cancellationToken: ct);
            patched.Add(name);
        }
        return patched;
    }

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
