using rPDU2MQTT.Core.Integrations;

namespace rPDU2MQTT.Services;

/// <summary>A plugin's hashes in Valkey/Redis, under <c>{prefix}plugin:{id}:{name}</c>.</summary>
public sealed class CachePluginStore(ICacheClient cache, string keyPrefix, string pluginId, Action<string>? warn = null) : IPluginStore
{
    private string Key(string name) => $"{keyPrefix}plugin:{pluginId}:{name}";

    public IReadOnlyDictionary<string, string> Read(string name)
    {
        try { return cache.HashGetAll(Key(name)); }
        catch (Exception ex) { warn?.Invoke($"Plugin '{pluginId}': could not read {name} from the cache ({ex.Message})."); return new Dictionary<string, string>(); }
    }

    public void Write(string name, IReadOnlyDictionary<string, string> fields)
    {
        try { foreach (var (field, value) in fields) cache.HashSetField(Key(name), field, value); }
        catch (Exception ex) { warn?.Invoke($"Plugin '{pluginId}': could not write {name} to the cache ({ex.Message})."); }
    }
}
