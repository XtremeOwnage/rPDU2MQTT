using System.Text.Json;
using System.Text.Json.Nodes;

namespace rPDU2MQTT.Core.Flow;

/// <summary>One importable reading found in someone else's Home Assistant MQTT discovery.</summary>
/// <param name="UniqueId">The publisher's unique_id, used to avoid importing the same entity twice.</param>
/// <param name="Label">What to call the node — the device name where there is one, else the entity name.</param>
/// <param name="Device">The device the entity belongs to, for grouping in the picker.</param>
/// <param name="StateTopic">The topic carrying the value.</param>
/// <param name="Metric">Our metric name: <c>realpower</c> or <c>energy</c>.</param>
/// <param name="Unit">The unit the publisher states (W, kW, Wh, kWh), converted on ingest.</param>
/// <param name="JsonField">Field to read from a JSON payload, or null when the payload is the bare value.</param>
/// <param name="Unsupported">Why this one cannot be bound automatically, or null when it can.</param>
public readonly record struct DiscoveredReading(
    string UniqueId, string Label, string Device, string StateTopic,
    string Metric, string? Unit, string? JsonField, string? Unsupported);

/// <summary>
/// Finds power and energy readings other integrations publish, by reading the Home Assistant MQTT
/// discovery they announce.
///
/// <para>
/// Discovery is used rather than per-integration topic patterns because it states the unit, the device
/// class and the payload shape. ESPHome, Z-Wave JS, Tasmota, Shelly and zigbee2mqtt all publish it. Topic
/// layouts would require a rule per integration, and each rule would infer a reading's meaning from its
/// topic name.
/// </para>
/// </summary>
public static class MqttDiscoveryImport
{
    /// <summary>Home Assistant device classes mapped to the metric vocabulary in <see cref="Abstractions.Flow.Metric"/>.</summary>
    private static readonly Dictionary<string, string> Metrics = new(StringComparer.OrdinalIgnoreCase)
    {
        ["power"] = "realpower",
        ["energy"] = "energy",
        ["current"] = "current",
        ["voltage"] = "voltage",
        ["frequency"] = "frequency",
        ["apparent_power"] = "apparentpower",
        ["power_factor"] = "powerfactor",
    };

    /// <summary>
    /// Every importable reading in one retained discovery config. Handles both layouts Home Assistant
    /// accepts: a single entity per topic, and the newer device bundle with a <c>components</c> map.
    /// </summary>
    /// <param name="ourDeviceIdPrefixes">
    /// Ids belonging to this bridge. Skipped: importing an entity this bridge published and re-exporting
    /// it duplicates the node in Home Assistant and double-counts it in any roll-up that aggregates it.
    /// </param>
    public static IReadOnlyList<DiscoveredReading> Parse(string payload, IReadOnlyCollection<string> ourDeviceIdPrefixes)
    {
        JsonNode? root;
        try { root = JsonNode.Parse(payload); }
        catch (JsonException) { return []; }
        if (root is not JsonObject doc) return [];

        var deviceName = (doc["device"] as JsonObject)?["name"]?.GetValue<string>() ?? "";
        var found = new List<DiscoveredReading>();

        if (doc["components"] is JsonObject components)
        {
            foreach (var (_, node) in components)
                if (node is JsonObject c && One(c, doc, deviceName, ourDeviceIdPrefixes) is { } r)
                    found.Add(r);
        }
        else if (One(doc, doc, deviceName, ourDeviceIdPrefixes) is { } single)
        {
            found.Add(single);
        }

        return found;
    }

    private static DiscoveredReading? One(JsonObject c, JsonObject doc, string deviceName, IReadOnlyCollection<string> ours)
    {
        var deviceClass = c["device_class"]?.GetValue<string>();
        if (deviceClass is null || !Metrics.TryGetValue(deviceClass, out var metric)) return null;

        var uniqueId = c["unique_id"]?.GetValue<string>() ?? "";
        if (uniqueId.Length == 0) return null;
        if (ours.Any(p => p.Length > 0 && uniqueId.StartsWith(p, StringComparison.OrdinalIgnoreCase))) return null;

        // state_topic may sit on the bundle rather than the component.
        var stateTopic = c["state_topic"]?.GetValue<string>() ?? doc["state_topic"]?.GetValue<string>();
        if (string.IsNullOrWhiteSpace(stateTopic)) return null;

        var name = c["name"]?.GetValue<string>() ?? uniqueId;
        var label = deviceName.Length > 0 ? $"{deviceName} {name}".Trim() : name;

        var (field, unsupported) = ReadTemplate(c["value_template"]?.GetValue<string>());

        return new DiscoveredReading(
            uniqueId, label, deviceName.Length > 0 ? deviceName : name, stateTopic!,
            metric, c["unit_of_measurement"]?.GetValue<string>(), field, unsupported);
    }

    /// <summary>
    /// Turn a discovery value_template into the JSON field our binding reads, or say it cannot be done.
    /// </summary>
    /// <remarks>
    /// Two shapes are accepted: no template (the payload is the value), and a plain
    /// <c>{{ value_json.a.b }}</c> lookup. Arithmetic, conditionals and filters are reported as
    /// unsupported: the template transforms the field, so the field is not the published value.
    /// </remarks>
    internal static (string? Field, string? Unsupported) ReadTemplate(string? template)
    {
        var t = template?.Trim();
        if (string.IsNullOrEmpty(t)) return (null, null);

        if (!t.StartsWith("{{") || !t.EndsWith("}}"))
            return (null, "its value template is not a simple field lookup");

        var inner = t[2..^2].Trim();
        if (inner == "value") return (null, null);                       // the bare payload, spelled out

        const string prefix = "value_json.";
        if (!inner.StartsWith(prefix, StringComparison.Ordinal))
            return (null, "its value template is not a simple field lookup");

        var path = inner[prefix.Length..].Trim();
        // A dotted path is fine (our binding walks it); anything else is arithmetic, a filter or a call.
        if (path.Length == 0 || path.Any(ch => !char.IsLetterOrDigit(ch) && ch != '_' && ch != '.'))
            return (null, "its value template does more than read a field");

        return (path, null);
    }

    /// <summary>
    /// A node id for an imported reading: lower-case, and safe to use in an MQTT topic and an HA unique_id.
    /// </summary>
    public static string NodeId(string uniqueId)
    {
        var chars = uniqueId.Trim().ToLowerInvariant()
            .Select(ch => char.IsLetterOrDigit(ch) ? ch : '_')
            .ToArray();
        var id = new string(chars).Trim('_');
        while (id.Contains("__")) id = id.Replace("__", "_");
        return id.Length > 0 ? id : "imported";
    }
}
