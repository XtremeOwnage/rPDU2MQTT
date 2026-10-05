using rPDU2MQTT.Services;
using Xunit;

public class PluginStoreTests
{
    private sealed class FakeCache : ICacheClient
    {
        public readonly Dictionary<string, Dictionary<string, string>> Hashes = new();
        public bool Fail;
        public IReadOnlyDictionary<string, string> HashGetAll(string key)
        {
            if (Fail) throw new InvalidOperationException("down");
            return Hashes.TryGetValue(key, out var h) ? h : new Dictionary<string, string>();
        }
        public void HashSet(string key, IReadOnlyDictionary<string, string> fields)
        {
            if (Fail) throw new InvalidOperationException("down");
            Hashes[key] = new Dictionary<string, string>(fields);
        }
        public bool Ping() => !Fail;
    }

    [Fact]
    public void APluginsHashes_AreKeyedByPrefixPluginAndName_AndWritesMerge()
    {
        var cache = new FakeCache();
        var store = new CachePluginStore(cache, "rpdu:", "tigo");

        store.Write("serials", new Dictionary<string, string> { ["a"] = "1" });
        store.Write("serials", new Dictionary<string, string> { ["b"] = "2" });

        Assert.Equal(new Dictionary<string, string> { ["a"] = "1", ["b"] = "2" }, cache.Hashes["rpdu:plugin:tigo:serials"]);
        Assert.Equal("2", store.Read("serials")["b"]);
    }

    [Fact]
    public void AnUnreachableCache_ReadsEmpty_AndWritesAreDropped_WithAWarning()
    {
        var warnings = new List<string>();
        var store = new CachePluginStore(new FakeCache { Fail = true }, "rpdu:", "tigo", warnings.Add);

        Assert.Empty(store.Read("serials"));
        store.Write("serials", new Dictionary<string, string> { ["a"] = "1" });
        Assert.Equal(2, warnings.Count);
    }
}
