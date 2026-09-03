using rPDU2MQTT.Services;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// How a high-water mark reaches Redis.
///
/// <para>
/// <c>HashSet</c> on this contract means "replace wholesale" — the real client deletes the key and rebuilds
/// every field inside a transaction. That is right for the energy totals, which one writer owns end to end,
/// and wrong for the marks, which move one at a time: it rebuilt a fifty-field hash to change one of them,
/// and where two replicas each hold a partial view it drops whatever the other one knew.
/// </para>
/// </summary>
public class RedisPeakWriteTests
{
    private sealed class RecordingCache : ICacheClient
    {
        public readonly Dictionary<string, Dictionary<string, string>> Hashes = new(StringComparer.Ordinal);
        public readonly List<string> WholesaleWrites = new();
        public readonly List<string> FieldWrites = new();

        public IReadOnlyDictionary<string, string> HashGetAll(string key)
            => Hashes.TryGetValue(key, out var h) ? h : new Dictionary<string, string>();

        public void HashSet(string key, IReadOnlyDictionary<string, string> fields)
        {
            WholesaleWrites.Add(key);
            Hashes[key] = new Dictionary<string, string>(fields, StringComparer.Ordinal);   // replaces
        }

        public void HashSetField(string key, string field, string value)
        {
            FieldWrites.Add($"{key}/{field}");
            if (!Hashes.TryGetValue(key, out var h)) Hashes[key] = h = new(StringComparer.Ordinal);
            h[field] = value;
        }

        public bool Ping() => true;
    }

    [Fact]
    public void AMarkIsWrittenAsOneFieldNotAWholeHash()
    {
        var cache = new RecordingCache();
        var store = new RedisEnergyStore(cache, "rpdu2mqtt:");

        store.SavePeak("solar|energy", 416.8);

        Assert.Equal(["rpdu2mqtt:energy:peaks/solar|energy"], cache.FieldWrites);
        Assert.Empty(cache.WholesaleWrites);
    }

    /// <summary>The mark another writer put there survives — that is the whole point of a per-field write.</summary>
    [Fact]
    public void AnotherWritersMarkIsUntouched()
    {
        var cache = new RecordingCache();
        var store = new RedisEnergyStore(cache, "rpdu2mqtt:");
        cache.HashSetField("rpdu2mqtt:energy:peaks", "grid|energy", "149.1");
        cache.FieldWrites.Clear();

        store.SavePeak("solar|energy", 416.8);

        var peaks = store.LoadPeaks();
        Assert.Equal(149.1, peaks["grid|energy"]);
        Assert.Equal(416.8, peaks["solar|energy"]);
    }

    [Fact]
    public void MarksComeBackAsNumbersInAnyCulture()
    {
        var cache = new RecordingCache();
        var store = new RedisEnergyStore(cache, "rpdu2mqtt:");
        store.SavePeak("solar|energy", 1234.5678);

        Assert.Equal(1234.5678, store.LoadPeaks()["solar|energy"], 6);
    }
}
