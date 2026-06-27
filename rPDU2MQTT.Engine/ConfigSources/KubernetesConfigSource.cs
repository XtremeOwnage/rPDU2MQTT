using System.Net;
using System.Text;
using System.Text.Json;
using k8s;
using k8s.Autorest;
using k8s.Models;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Services.Gui;

namespace rPDU2MQTT.Startup.ConfigSources;

/// <summary>
/// Reads (and writes) the configuration from a Kubernetes <c>RpduConfig</c> custom resource.
/// The CR <c>spec</c> uses the same field names as the GUI config JSON (see <see cref="ConfigSchema"/>),
/// so loading/saving reuses that round-trip. Secrets are never written to the CR spec — they are stored
/// in a companion Kubernetes <c>Secret</c> (<c>RPDU2MQTT_SECRET_NAME</c>) that the chart also mounts via
/// <c>envFrom</c>, so GUI-entered credentials persist without hand-editing the CR.
/// </summary>
public sealed class KubernetesConfigSource : IConfigSource
{
    public IKubernetes Client { get; }
    public string Name { get; }
    public string Namespace { get; }

    /// <summary>Name of the companion Secret holding credentials (the chart mounts it via envFrom).</summary>
    public string SecretName { get; }

    /// <summary>
    /// The secret config fields and the <c>RPDU2MQTT_*</c> keys they map to. Drives both reading secrets
    /// out of the companion Secret and writing GUI-entered secrets back into it.
    /// </summary>
    private static readonly (string Key, Func<Config, string?> Get, Action<Config, string?> Set)[] SecretFields =
    {
        ("RPDU2MQTT_MQTT_USERNAME", c => c.MQTT.Credentials?.Username, (c, v) => (c.MQTT.Credentials ??= new()).Username = v),
        ("RPDU2MQTT_MQTT_PASSWORD", c => c.MQTT.Credentials?.Password, (c, v) => (c.MQTT.Credentials ??= new()).Password = v),
        ("RPDU2MQTT_PDU_USERNAME",  c => c.Primary.Credentials?.Username,  (c, v) => (c.Primary.Credentials  ??= new()).Username = v),
        ("RPDU2MQTT_PDU_PASSWORD",  c => c.Primary.Credentials?.Password,  (c, v) => (c.Primary.Credentials  ??= new()).Password = v),
        ("RPDU2MQTT_EMONCMS_APIKEY", c => c.EmonCMS.ApiKey, (c, v) => c.EmonCMS.ApiKey = v),
        ("RPDU2MQTT_GUI_PASSWORD",   c => c.Gui.Password,   (c, v) => c.Gui.Password = v),
        ("RPDU2MQTT_OIDC_CLIENT_SECRET", c => c.Gui.Oidc?.ClientSecret, (c, v) => (c.Gui.Oidc ??= new()).ClientSecret = v),
    };

    public KubernetesConfigSource()
    {
        Name = Environment.GetEnvironmentVariable("RPDU2MQTT_CR_NAME")
            ?? throw new InvalidOperationException("RPDU2MQTT_CONFIG_SOURCE=k8s requires RPDU2MQTT_CR_NAME (the RpduConfig resource name).");
        Namespace = ResolveNamespace();
        // Defaults to the CR name (the chart names both after the release); chart sets it explicitly.
        SecretName = Environment.GetEnvironmentVariable("RPDU2MQTT_SECRET_NAME") ?? Name;

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
        // Secrets live in the companion Secret, not the CR spec; apply them before env overrides.
        ApplyManagedSecret(cfg);
        // Apply defaults + RPDU2MQTT_* env/secret overrides, same as the file source (env still wins).
        return YamlConfigLoader.Initialize(cfg);
    }

    public async Task SaveAsync(Config config, CancellationToken cancellationToken)
    {
        // Persist secrets into the companion Secret first; the CR spec is always written redacted.
        await WriteManagedSecretAsync(config, cancellationToken);

        var specJson = ConfigSchema.ToJson(ConfigSchema.RedactSecrets(config));
        // JSON Patch "add" on /spec replaces the whole spec (drops removed keys), unlike a merge patch.
        var patch = new V1Patch($"[{{\"op\":\"add\",\"path\":\"/spec\",\"value\":{specJson}}}]", V1Patch.PatchType.JsonPatch);
        await Client.CustomObjects.PatchNamespacedCustomObjectAsync(
            patch, RpduCrd.Group, RpduCrd.Version, Namespace, RpduCrd.Plural, Name, cancellationToken: cancellationToken);
    }

    /// <summary>Fill the config's secret fields from the companion Secret (if it exists / is readable).</summary>
    private void ApplyManagedSecret(Config config)
    {
        if (string.IsNullOrEmpty(SecretName))
            return;

        V1Secret secret;
        try
        {
            secret = Client.CoreV1.ReadNamespacedSecretAsync(SecretName, Namespace).GetAwaiter().GetResult();
        }
        catch (HttpOperationException ex) when (ex.Response is { StatusCode: HttpStatusCode.NotFound })
        {
            return; // No companion Secret yet — secrets come from env / GUI save.
        }
        catch (Exception ex)
        {
            Log.Warning($"Could not read credentials Secret {Namespace}/{SecretName}: {ex.Message}");
            return;
        }

        if (secret.Data is null)
            return;

        foreach (var (key, _, set) in SecretFields)
            if (secret.Data.TryGetValue(key, out var bytes) && bytes is { Length: > 0 })
                set(config, Encoding.UTF8.GetString(bytes));
    }

    /// <summary>Write the config's non-empty secret fields into the companion Secret (create or merge).</summary>
    private async Task WriteManagedSecretAsync(Config config, CancellationToken cancellationToken)
    {
        if (string.IsNullOrEmpty(SecretName))
        {
            Log.Warning("RPDU2MQTT_SECRET_NAME is not set; GUI-entered credentials were not persisted. Provide secrets via your Secret/env vars instead.");
            return;
        }

        var stringData = new Dictionary<string, string>();
        foreach (var (key, get, _) in SecretFields)
        {
            var value = get(config);
            if (!string.IsNullOrEmpty(value))
                stringData[key] = value;
        }

        if (stringData.Count == 0)
            return;

        var patch = new V1Patch(JsonSerializer.Serialize(new { stringData }), V1Patch.PatchType.MergePatch);
        try
        {
            await Client.CoreV1.PatchNamespacedSecretAsync(patch, SecretName, Namespace, cancellationToken: cancellationToken);
        }
        catch (HttpOperationException ex) when (ex.Response is { StatusCode: HttpStatusCode.NotFound })
        {
            var secret = new V1Secret
            {
                Metadata = new V1ObjectMeta { Name = SecretName, NamespaceProperty = Namespace },
                StringData = stringData,
            };
            await Client.CoreV1.CreateNamespacedSecretAsync(secret, Namespace, cancellationToken: cancellationToken);
        }
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
