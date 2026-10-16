using System.Text.Json;
using System.Text.Json.Nodes;

namespace rPDU2MQTT.Core.Integrations;

/// <summary>An integration that carries its own configuration section, stored under <c>Config.Plugins[id]</c>.</summary>
public interface IConfigurablePlugin
{
    /// <summary>The plugin's settings class.</summary>
    Type ConfigType { get; }

    /// <summary>Applies settings bound to <see cref="ConfigType"/>; called on load and on every config save.</summary>
    void ApplyConfig(object settings);
}

/// <summary>Binds <c>Config.Plugins</c> sections to each plugin's settings class.</summary>
public static class PluginConfigBinder
{
    private static readonly JsonSerializerOptions Options = new()
    {
        PropertyNameCaseInsensitive = true,
        WriteIndented = false,
        NumberHandling = System.Text.Json.Serialization.JsonNumberHandling.AllowReadingFromString,
        Converters = { new LenientStringConverter() },
    };

    /// <summary>Binds the plugin's section, falling back to defaults when missing or unreadable.</summary>
    public static object Bind(
        IConfigurablePlugin plugin, string id, IDictionary<string, object?> sections, Action<string>? warn = null)
    {
        var settings = Activator.CreateInstance(plugin.ConfigType)
                       ?? throw new InvalidOperationException($"Plugin '{id}' config type {plugin.ConfigType.Name} has no parameterless constructor.");

        if (sections.TryGetValue(id, out var raw) && raw is not null)
        {
            try
            {
                settings = JsonSerializer.Deserialize(ToJson(raw)?.ToJsonString() ?? "{}", plugin.ConfigType, Options) ?? settings;
            }
            catch (Exception ex)
            {
                warn?.Invoke($"Plugin '{id}': its configuration could not be read ({ex.Message}); using defaults. "
                           + "The stored section is left untouched so nothing is lost by this.");
            }
        }

        plugin.ApplyConfig(settings);
        return settings;
    }

    /// <summary>Serialises settings to a storable node.</summary>
    public static object? ToNode(object settings)
        => JsonNode.Parse(JsonSerializer.Serialize(settings, settings.GetType(), Options));

    /// <summary>Converts YAML loader output (nested dictionaries, lists, scalars) to JSON.</summary>
    public static JsonNode? ToJson(object? value)
    {
        switch (value)
        {
            case null: return null;
            case JsonNode node: return ToJson(JsonSerializer.SerializeToElement(node));
            case JsonElement el:
                switch (el.ValueKind)
                {
                    case JsonValueKind.Object:
                    {
                        var obj = new JsonObject();
                        foreach (var p in el.EnumerateObject())
                            if (ToJson(p.Value) is { } v) obj[p.Name] = v;
                        return obj;
                    }
                    case JsonValueKind.Array:
                    {
                        var arr = new JsonArray();
                        foreach (var item in el.EnumerateArray()) arr.Add(ToJson(item));
                        return arr;
                    }
                    case JsonValueKind.String: return ToJson(el.GetString());
                    case JsonValueKind.Number: return el.TryGetInt64(out var n) ? JsonValue.Create(n) : JsonValue.Create(el.GetDouble());
                    case JsonValueKind.True: return JsonValue.Create(true);
                    case JsonValueKind.False: return JsonValue.Create(false);
                    default: return null;
                }
            case System.Collections.IDictionary map:
            {
                var obj = new JsonObject();
                // Blank fields are skipped so defaults apply.
                foreach (System.Collections.DictionaryEntry e in map)
                    if (e.Key?.ToString() is { } key && ToJson(e.Value) is { } v) obj[key] = v;
                return obj;
            }
            // YAML scalars arrive as strings; recover bools and numbers.
            case string s:
                if (s.Length == 0) return null;
                if (bool.TryParse(s, out var b)) return JsonValue.Create(b);
                if (long.TryParse(s, System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out var i)) return JsonValue.Create(i);
                if (double.TryParse(s, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var d)) return JsonValue.Create(d);
                return JsonValue.Create(s);
            case System.Collections.IEnumerable list:
            {
                var arr = new JsonArray();
                foreach (var item in list) arr.Add(ToJson(item));
                return arr;
            }
            case bool flag: return JsonValue.Create(flag);
            case int or long or short or byte or uint or ulong or ushort or sbyte:
                return JsonValue.Create(Convert.ToInt64(value, System.Globalization.CultureInfo.InvariantCulture));
            case double or float or decimal:
                return JsonValue.Create(Convert.ToDouble(value, System.Globalization.CultureInfo.InvariantCulture));
            default: return JsonValue.Create(value.ToString());
        }
    }
}
