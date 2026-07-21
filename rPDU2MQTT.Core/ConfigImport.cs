using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using rPDU2MQTT.Classes;
using YamlDotNet.RepresentationModel;
using YamlDotNet.Serialization;

namespace rPDU2MQTT.Core;

/// <summary>How a pasted config is applied to the running one (#214).</summary>
public enum ConfigImportMode
{
    /// <summary>
    /// Apply only what the paste actually mentions, leaving everything else exactly as it is — so a section
    /// copied out of a dev instance can be carried to production without dragging the rest of dev with it.
    /// </summary>
    Merge,

    /// <summary>
    /// The paste becomes the whole configuration: anything it doesn't mention goes back to its default.
    /// Pasting a complete export, in other words.
    /// </summary>
    Replace,
}

/// <summary>What an import would do — returned for review before anything is saved.</summary>
/// <param name="Config">The resulting configuration.</param>
/// <param name="Sections">The top-level sections the paste mentioned, in the model's own names.</param>
/// <param name="Notes">Anything the user should know (a Kubernetes wrapper unwrapped, keys ignored, …).</param>
public sealed record ConfigImportResult(Config Config, List<string> Sections, List<string> Notes);

/// <summary>
/// Applies a pasted config fragment to the current one (#214).
/// <para>
/// The interesting half is <see cref="ConfigImportMode.Merge"/>: "only what the paste mentions" can't be
/// answered by deserializing it, because deserializing fills in a default for every key the paste left out —
/// and those defaults are indistinguishable from deliberate values. So the YAML document is walked
/// separately to learn which keys are actually <i>present</i>, and that mask decides what gets applied. A
/// list is treated as one value: half-merging two lists of nodes would produce a topology neither side asked
/// for.
/// </para>
/// </summary>
public static class ConfigImport
{
    private static readonly JsonSerializerOptions Json = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        PropertyNameCaseInsensitive = true,
        Converters = { new JsonStringEnumConverter() },
    };

    public static ConfigImportResult Apply(Config current, string yaml, ConfigImportMode mode)
    {
        if (string.IsNullOrWhiteSpace(yaml))
            throw new ArgumentException("Nothing to import — paste a config.yaml or an RpduConfig manifest.");

        var notes = new List<string>();
        var root = ParseRoot(yaml, notes);
        if (root is null || root.Children.Count == 0)
            throw new ArgumentException("That doesn't look like a configuration — expected YAML with at least one section.");

        // Typed values (defaults included) plus the mask of what the paste actually said.
        var fragment = Deserialize(yaml, notes);
        var fragmentJson = JsonSerializer.SerializeToNode(fragment, Json)!.AsObject();
        var mask = Mask(typeof(Config), root);

        var sections = mask.Keys.OrderBy(s => s, StringComparer.OrdinalIgnoreCase).ToList();
        if (sections.Count == 0)
            throw new ArgumentException("None of the keys in that paste match the configuration model.");

        if (mode == ConfigImportMode.Replace)
            return new ConfigImportResult(fragment, sections, notes);

        var merged = JsonSerializer.SerializeToNode(current, Json)!.AsObject();
        MergeMasked(merged, fragmentJson, mask);

        var result = JsonSerializer.Deserialize<Config>(merged, Json)
            ?? throw new InvalidOperationException("The merged configuration could not be rebuilt.");
        return new ConfigImportResult(result, sections, notes);
    }

    /// <summary>The document's config mapping — unwrapping a Kubernetes <c>RpduConfig</c> if that's what it is.</summary>
    private static YamlMappingNode? ParseRoot(string yaml, List<string> notes)
    {
        var stream = new YamlStream();
        using var reader = new StringReader(yaml);
        stream.Load(reader);

        if (stream.Documents.Count == 0) return null;
        if (stream.Documents[0].RootNode is not YamlMappingNode root) return null;

        // An exported manifest carries the config under spec:; take it rather than making the user edit it out.
        if (Child(root, "kind") is YamlScalarNode { Value: "RpduConfig" } && Child(root, "spec") is YamlMappingNode spec)
        {
            notes.Add("Read the configuration from the RpduConfig manifest's spec.");
            return spec;
        }
        return root;
    }

    private static YamlNode? Child(YamlMappingNode map, string key)
        => map.Children.FirstOrDefault(kv => kv.Key is YamlScalarNode s
            && string.Equals(s.Value, key, StringComparison.OrdinalIgnoreCase)).Value;

    private static Config Deserialize(string yaml, List<string> notes)
    {
        // Unwrap a manifest for the typed pass too, by re-emitting just the spec.
        var stream = new YamlStream();
        using (var reader = new StringReader(yaml)) stream.Load(reader);
        var text = yaml;
        if (stream.Documents.FirstOrDefault()?.RootNode is YamlMappingNode root
            && Child(root, "kind") is YamlScalarNode { Value: "RpduConfig" }
            && Child(root, "spec") is YamlMappingNode spec)
        {
            var doc = new YamlDocument(spec);
            var outStream = new YamlStream(doc);
            using var writer = new StringWriter();
            outStream.Save(writer, assignAnchors: false);
            text = writer.ToString();
        }

        var deserializer = new DeserializerBuilder()
            .WithCaseInsensitivePropertyMatching()
            .IgnoreFields()
            .IgnoreUnmatchedProperties()   // a paste may carry keys from a newer/older version; say so, don't fail
            .Build();

        try
        {
            using var reader = new StringReader(text);
            return deserializer.Deserialize<Config>(reader) ?? new Config();
        }
        catch (Exception ex)
        {
            throw new ArgumentException($"That YAML could not be read as a configuration: {ex.Message}");
        }
    }

    /// <summary>
    /// Which properties of <paramref name="type"/> the paste mentions, recursively. The value is a nested
    /// mask for an object, or null for "take this whole thing" (a scalar, a list, or a dictionary).
    /// </summary>
    private static Dictionary<string, Dictionary<string, object?>?> Mask(Type type, YamlMappingNode node)
    {
        var mask = new Dictionary<string, Dictionary<string, object?>?>(StringComparer.Ordinal);

        foreach (var (keyNode, valueNode) in node.Children)
        {
            if (keyNode is not YamlScalarNode { Value: { } key }) continue;
            if (MatchProperty(type, key) is not { } property) continue;

            // Recurse only into plain objects: a list is one value, and a dictionary's keys are data
            // (instance names, override keys), not model properties.
            // Key the mask by the property's *JSON* name, because that's what the merge below reads —
            // Config.HASS serializes as "HomeAssistant", and keying by the C# name would silently miss it.
            var name = JsonName(property);
            if (valueNode is YamlMappingNode child && IsPlainObject(property.PropertyType))
                mask[name] = Mask(property.PropertyType, child).ToDictionary(kv => kv.Key, kv => (object?)kv.Value);
            else
                mask[name] = null;
        }

        return mask;
    }

    /// <summary>Match a YAML key to a property by its YAML alias, its JSON name, or its own name.</summary>
    private static PropertyInfo? MatchProperty(Type type, string key)
    {
        foreach (var p in type.GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            if (!p.CanWrite && !IsPlainObject(p.PropertyType)) continue;

            var alias = p.GetCustomAttribute<YamlMemberAttribute>()?.Alias;
            var json = p.GetCustomAttribute<JsonPropertyNameAttribute>()?.Name;
            if (string.Equals(p.Name, key, StringComparison.OrdinalIgnoreCase)
                || string.Equals(alias, key, StringComparison.OrdinalIgnoreCase)
                || string.Equals(json, key, StringComparison.OrdinalIgnoreCase))
                return p;
        }
        return null;
    }

    /// <summary>The name this property serializes to — what the merge and the section list both use.</summary>
    private static string JsonName(PropertyInfo property)
        => property.GetCustomAttribute<JsonPropertyNameAttribute>()?.Name ?? property.Name;

    private static bool IsPlainObject(Type type)
        => type.IsClass
        && type != typeof(string)
        && !typeof(System.Collections.IEnumerable).IsAssignableFrom(type);

    /// <summary>Copy the masked properties of <paramref name="from"/> onto <paramref name="into"/>.</summary>
    private static void MergeMasked(JsonObject into, JsonObject from, Dictionary<string, Dictionary<string, object?>?> mask)
    {
        foreach (var (name, child) in mask)
        {
            if (!from.TryGetPropertyValue(name, out var value)) continue;

            if (child is { Count: > 0 } && value is JsonObject valueObject
                && into.TryGetPropertyValue(name, out var existing) && existing is JsonObject existingObject)
            {
                MergeMasked(existingObject, valueObject, child.ToDictionary(kv => kv.Key, kv => (Dictionary<string, object?>?)kv.Value));
                continue;
            }

            into[name] = value?.DeepClone();
        }
    }
}
