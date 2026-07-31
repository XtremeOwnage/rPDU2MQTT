using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Services;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// The store's own behaviour — key naming, serialisation, and what it does when the cache misbehaves —
/// exercised through <see cref="ICacheClient"/>.
///
/// <para>
/// That seam exists for exactly this: the StackExchange.Redis adapter is a thin wrapper over library
/// calls and needs a live server to mean anything, while everything that could plausibly be wrong lives
/// here and needs none.
/// </para>
/// </summary>
public class RedisEnergyStoreTests
{
    /// <summary>An in-memory stand-in that really stores what it is given, and can be made to fail.</summary>
    private sealed class FakeCache : ICacheClient
    {
        public readonly Dictionary<string, Dictionary<string, string>> Data = new();
        public bool Down;
        public int Writes;

        public IReadOnlyDictionary<string, string> HashGetAll(string key)
        {
            if (Down) throw new InvalidOperationException("cache is not connected");
            return Data.TryGetValue(key, out var h) ? h : new Dictionary<string, string>();
        }

        public bool Ping() => !Down;

        public void HashSet(string key, IReadOnlyDictionary<string, string> fields)
        {
            if (Down) throw new InvalidOperationException("cache is not connected");
            Writes++;
            Data[key] = fields.ToDictionary(kv => kv.Key, kv => kv.Value);
        }
    }

    private static readonly DateTime At = new(2026, 7, 30, 12, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void TotalsRoundTripUnderThePrefixedKey()
    {
        var cache = new FakeCache();
        var store = new RedisEnergyStore(cache, "rpdu2mqtt:");
        store.Save(new Dictionary<string, EnergyState> { ["solar"] = new(12.5, At, 1000, 30) });

        Assert.True(cache.Data.ContainsKey("rpdu2mqtt:energy"));   // the prefix is honoured

        var back = new RedisEnergyStore(cache, "rpdu2mqtt:").Load();
        Assert.Equal(12.5, back["solar"].KWh);
        Assert.Equal(At, back["solar"].LastSampleUtc);
        Assert.Equal(1000, back["solar"].LastPowerW);
        Assert.Equal(30, back["solar"].UnmeasuredSeconds);
    }

    [Fact]
    public void ARemovedNode_DoesNotLingerInTheCache()
    {
        // The hash is replaced wholesale, so a node deleted from the config stops being reported. Merging
        // instead would leave its total there forever, and it would reappear in the roll-up.
        var cache = new FakeCache();
        var store = new RedisEnergyStore(cache, "p:");
        store.Save(new Dictionary<string, EnergyState> { ["a"] = new(1, At, 10, 0), ["b"] = new(2, At, 20, 0) });
        store.Save(new Dictionary<string, EnergyState> { ["a"] = new(3, At, 10, 0) });

        var back = store.Load();
        Assert.Equal(3, back["a"].KWh);
        Assert.False(back.ContainsKey("b"));
    }

    [Fact]
    public void AnUnreachableCache_DoesNotThrow_AndComplainsOnlyOnce()
    {
        // Losing a sample beats taking the bridge down, and an outage lasts many passes — one line, not one
        // per pass. It must speak up again after a recovery, or the next outage would be silent.
        var cache = new FakeCache { Down = true };
        var warnings = new List<string>();
        var store = new RedisEnergyStore(cache, "p:", warnings.Add);

        Assert.Empty(store.Load());
        store.Save(new Dictionary<string, EnergyState> { ["a"] = new(1, At, 10, 0) });
        store.Save(new Dictionary<string, EnergyState> { ["a"] = new(2, At, 10, 0) });
        Assert.Single(warnings);

        cache.Down = false;
        store.Save(new Dictionary<string, EnergyState> { ["a"] = new(3, At, 10, 0) });
        cache.Down = true;
        store.Save(new Dictionary<string, EnergyState> { ["a"] = new(4, At, 10, 0) });
        Assert.Equal(2, warnings.Count);
    }

    [Fact]
    public void OneUnreadableField_DoesNotDiscardTheOthers()
    {
        // A single corrupt entry must cost that node its total, not every node's.
        var cache = new FakeCache();
        cache.Data["p:energy"] = new Dictionary<string, string>
        {
            ["good"] = System.Text.Json.JsonSerializer.Serialize(new EnergyState(5, At, 100, 0)),
            ["bad"] = "{ not json",
        };
        var warnings = new List<string>();

        var back = new RedisEnergyStore(cache, "p:", warnings.Add).Load();

        Assert.Equal(5, back["good"].KWh);
        Assert.False(back.ContainsKey("bad"));
        Assert.Single(warnings);
        Assert.Contains("bad", warnings[0]);
    }
}
