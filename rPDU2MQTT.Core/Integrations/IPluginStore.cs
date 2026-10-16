namespace rPDU2MQTT.Core.Integrations;

/// <summary>Named hashes a plugin keeps across restarts. Shared by replicas when the cache is on.</summary>
public interface IPluginStore
{
    /// <summary>Every field of a hash; empty when it doesn't exist or the store is unreachable.</summary>
    IReadOnlyDictionary<string, string> Read(string name);

    /// <summary>Set fields, leaving the others alone.</summary>
    void Write(string name, IReadOnlyDictionary<string, string> fields);
}

/// <summary>Keeps nothing: no cache is configured.</summary>
public sealed class NullPluginStore : IPluginStore
{
    public IReadOnlyDictionary<string, string> Read(string name) => new Dictionary<string, string>();
    public void Write(string name, IReadOnlyDictionary<string, string> fields) { }
}

/// <summary>An integration the host hands its store to before first use.</summary>
public interface IPluginStoreUser
{
    void UseStore(IPluginStore store);
}
