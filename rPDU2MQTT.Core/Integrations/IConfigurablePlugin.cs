using System.Text.Json;
using System.Text.Json.Nodes;

namespace rPDU2MQTT.Core.Integrations;

/// <summary>
/// An integration that carries its own configuration section.
///
/// <para>
/// A built-in integration hangs its config off a property on <c>Config</c>, which is typed all the way
/// through — the GUI, the YAML round-trip, the CRD and the change diff all come free. An externally loaded
/// plugin cannot do that: <c>Config</c> is compiled before the plugin exists. So it declares a config
/// <i>type</i> instead, and its section is stored under <c>Config.Plugins[id]</c> and bound to that type on
/// load.
/// </para>
/// <para>
/// The plugin author still writes an ordinary class with ordinary <c>[Description]</c> and
/// <c>[DefaultValue]</c> attributes and gets a rendered settings page for it, because the GUI's form is
/// driven by a schema generated at runtime — not compiled into the bundle. That is the property that makes
/// runtime-loaded plugins possible at all here, and it was already true before anyone needed it to be.
/// </para>
/// </summary>
public interface IConfigurablePlugin
{
    /// <summary>
    /// The plugin's settings class. Plain properties with <c>[Description]</c>/<c>[DefaultValue]</c>; the
    /// schema generator reads it exactly as it reads a built-in section.
    /// </summary>
    Type ConfigType { get; }

    /// <summary>
    /// Hand the plugin its settings, bound to <see cref="ConfigType"/>. Called on load and again whenever
    /// the configuration is saved, so a plugin follows a live edit the way built-ins do.
    /// </summary>
    void ApplyConfig(object settings);
}

/// <summary>
/// Binds the untyped <c>Config.Plugins</c> sections to each plugin's own settings class, and back.
/// </summary>
/// <remarks>
/// JSON is the intermediate form because the config document already round-trips through it for the GUI,
/// and because a plugin's type is not known to the YAML serialiser at startup.
/// </remarks>
public static class PluginConfigBinder
{
    private static readonly JsonSerializerOptions Options = new()
    {
        PropertyNameCaseInsensitive = true,
        WriteIndented = false,
        // A belt-and-braces companion to the scalar typing above: a settings class that declares an int
        // still binds if a value slips through as a string.
        NumberHandling = System.Text.Json.Serialization.JsonNumberHandling.AllowReadingFromString,
    };

    /// <summary>
    /// Give <paramref name="plugin"/> its section from <paramref name="sections"/>, or a default-constructed
    /// one when it has never been configured. A section that will not bind is reported and the plugin gets
    /// defaults — a malformed block for one plugin must not stop the others loading.
    /// </summary>
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

    /// <summary>The section as it should be stored, for writing a default block back out on first load.</summary>
    public static object? ToNode(object settings)
        => JsonNode.Parse(JsonSerializer.Serialize(settings, settings.GetType(), Options));

    /// <summary>
    /// Whatever the YAML loader produced — nested dictionaries, lists, scalars — as JSON.
    /// </summary>
    /// <remarks>
    /// YamlDotNet yields <c>Dictionary&lt;object, object&gt;</c> with boxed keys, which System.Text.Json
    /// refuses to serialise directly. Walking it here is what lets a plugin declare an ordinary settings
    /// class and have a YAML block bind to it.
    /// </remarks>
    public static JsonNode? ToJson(object? value)
    {
        switch (value)
        {
            case null: return null;
            case JsonNode node: return node;
            case System.Collections.IDictionary map:
            {
                var obj = new JsonObject();
                foreach (System.Collections.DictionaryEntry e in map)
                    if (e.Key?.ToString() is { } key) obj[key] = ToJson(e.Value);
                return obj;
            }
            // YAML scalars arrive as strings, so "true" and "10" have to be recovered as the types a
            // settings class actually declares — otherwise every bool and every number fails to bind and
            // the plugin silently runs on defaults.
            case string s:
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
            default: return JsonValue.Create(value.ToString());
        }
    }
}
