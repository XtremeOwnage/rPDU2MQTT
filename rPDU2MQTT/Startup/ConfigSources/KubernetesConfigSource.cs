using System.Text.Json;
using k8s;
using k8s.Models;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Services.Gui;

namespace rPDU2MQTT.Startup.ConfigSources;

/// <summary>
/// Reads (and writes) the configuration from a Kubernetes <c>RpduConfig</c> custom resource.
/// The CR <c>spec</c> uses the same field names as the GUI config JSON (see <see cref="ConfigSchema"/>),
/// so loading/saving reuses that round-trip. Secrets are never written to the CR — they come from the
/// usual <c>RPDU2MQTT_*</c> env/Secret overrides.
/// </summary>
public sealed class KubernetesConfigSource : IConfigSource
{
    public IKubernetes Client { get; }
    public string Name { get; }
    public string Namespace { get; }

    public KubernetesConfigSource()
    {
        Name = Environment.GetEnvironmentVariable("RPDU2MQTT_CR_NAME")
            ?? throw new InvalidOperationException("RPDU2MQTT_CONFIG_SOURCE=k8s requires RPDU2MQTT_CR_NAME (the RpduConfig resource name).");
        Namespace = ResolveNamespace();

        var config = KubernetesClientConfiguration.BuildDefaultConfig();
        Client = new Kubernetes(config);
    }

    public string Describe => $"Kubernetes RpduConfig {Namespace}/{Name}";
    public bool CanWrite => true;
    public bool IsGitOpsManaged => true;

    public Config Load()
    {
        // One-time synchronous read at startup is acceptable.
        var obj = Client.CustomObjects
            .GetNamespacedCustomObjectAsync(RpduCrd.Group, RpduCrd.Version, Namespace, RpduCrd.Plural, Name)
            .GetAwaiter().GetResult();

        var root = obj is JsonElement je ? je : JsonSerializer.SerializeToElement(obj);
        if (!root.TryGetProperty("spec", out var spec) || spec.ValueKind != JsonValueKind.Object)
            throw new InvalidOperationException($"RpduConfig {Namespace}/{Name} has no 'spec'.");

        var cfg = ConfigSchema.FromJson(spec.GetRawText());
        // Apply defaults + RPDU2MQTT_* secret/env overrides, same as the file source.
        return YamlConfigLoader.Initialize(cfg);
    }

    public async Task SaveAsync(Config config, CancellationToken cancellationToken)
    {
        var specJson = ConfigSchema.ToJson(ConfigSchema.RedactSecrets(config));
        // JSON Patch "add" on /spec replaces the whole spec (drops removed keys), unlike a merge patch.
        var patch = new V1Patch($"[{{\"op\":\"add\",\"path\":\"/spec\",\"value\":{specJson}}}]", V1Patch.PatchType.JsonPatch);
        await Client.CustomObjects.PatchNamespacedCustomObjectAsync(
            patch, RpduCrd.Group, RpduCrd.Version, Namespace, RpduCrd.Plural, Name, cancellationToken: cancellationToken);
    }

    /// <summary>Patch the CR's status subresource.</summary>
    public async Task PatchStatusAsync(object status, CancellationToken cancellationToken)
    {
        var statusJson = JsonSerializer.Serialize(status, ConfigSchema.Json);
        var patch = new V1Patch($"[{{\"op\":\"add\",\"path\":\"/status\",\"value\":{statusJson}}}]", V1Patch.PatchType.JsonPatch);
        await Client.CustomObjects.PatchNamespacedCustomObjectStatusAsync(
            patch, RpduCrd.Group, RpduCrd.Version, Namespace, RpduCrd.Plural, Name, cancellationToken: cancellationToken);
    }

    /// <summary>Serialize the current CR's spec to a stable string for change detection.</summary>
    public async Task<string> ReadSpecRawAsync(CancellationToken cancellationToken)
    {
        var obj = await Client.CustomObjects.GetNamespacedCustomObjectAsync(
            RpduCrd.Group, RpduCrd.Version, Namespace, RpduCrd.Plural, Name, cancellationToken: cancellationToken);
        var root = obj is JsonElement je ? je : JsonSerializer.SerializeToElement(obj);
        return root.TryGetProperty("spec", out var spec) ? spec.GetRawText() : string.Empty;
    }

    private static string ResolveNamespace()
    {
        var ns = Environment.GetEnvironmentVariable("RPDU2MQTT_NAMESPACE");
        if (!string.IsNullOrWhiteSpace(ns))
            return ns;

        const string saNamespace = "/var/run/secrets/kubernetes.io/serviceaccount/namespace";
        if (File.Exists(saNamespace))
            return File.ReadAllText(saNamespace).Trim();

        return "default";
    }
}
