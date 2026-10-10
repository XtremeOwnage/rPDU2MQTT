using System.Text.Json;
using rPDU2MQTT.Models.Config;

namespace rPDU2MQTT.Core.Integrations;

/// <summary>
/// A plugin that keeps settings of its own on core entities it does not define, such as the room a node is in.
/// They are stored in the entity's <see cref="IExtensible.Ext"/> under the plugin's id, and the editors render
/// them from the settings class, as a plugin's own section is.
/// </summary>
public interface IEntityExtensionProvider
{
    /// <summary>The settings class kept on each kind of entity, keyed by <see cref="EntityKind"/>.</summary>
    IReadOnlyDictionary<string, Type> EntityExtensions { get; }
}

/// <summary>One plugin's settings class for one kind of entity.</summary>
public sealed record EntityExtension(string PluginId, string Label, string Entity, Type ConfigType);

/// <summary>Reads and writes a plugin's settings on an entity.</summary>
public static class EntityExtensions
{
    private static readonly JsonSerializerOptions Options = new()
    {
        PropertyNameCaseInsensitive = true,
        NumberHandling = System.Text.Json.Serialization.JsonNumberHandling.AllowReadingFromString,
    };

    /// <summary>Every declared extension of the loaded plugins.</summary>
    public static IEnumerable<EntityExtension> Of(IEnumerable<IIntegration> plugins)
        => plugins.OfType<IEntityExtensionProvider>()
                  .SelectMany(p => p.EntityExtensions.Select(e => new EntityExtension(((IIntegration)p).Id, ((IIntegration)p).DisplayName, e.Key, e.Value)));

    /// <summary>The plugin's settings on this entity, or defaults when it has none or they cannot be read.</summary>
    public static T Read<T>(IExtensible entity, string pluginId, Action<string>? warn = null) where T : new()
        => (T)Read(entity, pluginId, typeof(T), warn);

    public static object Read(IExtensible entity, string pluginId, Type type, Action<string>? warn = null)
    {
        var fallback = Activator.CreateInstance(type)
                       ?? throw new InvalidOperationException($"{type.Name} has no parameterless constructor.");
        if (entity.Ext is null || !entity.Ext.TryGetValue(pluginId, out var raw) || raw is null) return fallback;
        try
        {
            return JsonSerializer.Deserialize(PluginConfigBinder.ToJson(raw)?.ToJsonString() ?? "{}", type, Options) ?? fallback;
        }
        catch (Exception ex)
        {
            // Left as stored: a value the plugin cannot read today may be one a newer version can.
            warn?.Invoke($"Plugin '{pluginId}': its settings on an entity could not be read ({ex.Message}); using defaults.");
            return fallback;
        }
    }

    /// <summary>Store the plugin's settings on this entity; null removes them, and an emptied bag is dropped.</summary>
    public static void Write(IExtensible entity, string pluginId, object? settings)
    {
        if (settings is null)
        {
            if (entity.Ext is null) return;
            entity.Ext.Remove(pluginId);
            if (entity.Ext.Count == 0) entity.Ext = null;
            return;
        }
        entity.Ext ??= new Dictionary<string, object?>();
        entity.Ext[pluginId] = PluginConfigBinder.ToNode(settings);
    }
}
