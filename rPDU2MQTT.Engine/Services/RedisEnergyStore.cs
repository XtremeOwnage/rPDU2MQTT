using System.Text.Json;
using rPDU2MQTT.Core.Flow;

namespace rPDU2MQTT.Services;

/// <summary>
/// The one thing this store needs from Redis. Narrow on purpose: everything interesting — key naming,
/// serialisation, what happens when the instance is unreachable — is then testable without a server, and
/// the StackExchange.Redis dependency is confined to a single adapter.
/// </summary>
public interface ICacheClient
{
    /// <summary>All field/value pairs of a hash, empty when it doesn't exist.</summary>
    IReadOnlyDictionary<string, string> HashGetAll(string key);

    /// <summary>Replace a hash wholesale.</summary>
    void HashSet(string key, IReadOnlyDictionary<string, string> fields);

    /// <summary>
    /// Is the cache actually answering? Needed because the Status board must tell the truth about a cache
    /// nothing happens to be using — energy aggregation is off by default, so without an active probe the
    /// card only ever reported the state of traffic that never occurred.
    /// </summary>
    bool Ping();
}

/// <summary>
/// Accumulated energy in Redis/Valkey, so several replicas share one set of totals and a restart doesn't
/// look like a meter reset.
///
/// <para>
/// Stored as a single hash — one field per node — rather than a key each: the accumulator writes the whole
/// set after every pass, and one round-trip keeps that cheap. The values are the same JSON the file store
/// writes, so the two are interchangeable and a deployment can move between them.
/// </para>
/// <para>
/// If the instance is unreachable this reports empty and says so, rather than throwing: the caller keeps
/// accumulating in memory, and a later pass reconnects. Losing a sample beats taking the bridge down.
/// </para>
/// </summary>
public sealed class RedisEnergyStore : IEnergyStore
{
    private readonly ICacheClient cache;
    private readonly string key;
    private readonly Action<string>? warn;
    private bool complained;

    public RedisEnergyStore(ICacheClient cache, string keyPrefix, Action<string>? warn = null)
    {
        this.cache = cache;
        this.key = (keyPrefix ?? "") + "energy";
        this.warn = warn;
    }

    public IReadOnlyDictionary<string, EnergyState> Load()
    {
        var states = new Dictionary<string, EnergyState>();
        try
        {
            foreach (var (node, json) in cache.HashGetAll(key))
            {
                // One unreadable field must not discard every other node's total.
                try
                {
                    var s = JsonSerializer.Deserialize<EnergyState>(json);
                    states[node] = s;
                }
                catch (JsonException ex)
                {
                    warn?.Invoke($"Energy total for '{node}' in {key} is unreadable ({ex.Message}); that node restarts from zero.");
                }
            }
        }
        catch (Exception ex)
        {
            Complain($"Could not read the energy totals from the cache ({ex.Message}). Accumulation starts from "
                   + "zero for this run, which downstream consumers will read as a meter reset.");
        }
        return states;
    }

    public void Save(IReadOnlyDictionary<string, EnergyState> states)
    {
        try
        {
            cache.HashSet(key, states.ToDictionary(kv => kv.Key, kv => JsonSerializer.Serialize(kv.Value)));
            complained = false;   // it's back; a later outage is worth reporting again
        }
        catch (Exception ex)
        {
            Complain($"Could not write the energy totals to the cache ({ex.Message}). They are still accumulating "
                   + "in memory, but a restart before it recovers will lose them.");
        }
    }

    // An unreachable cache fails on every pass; say it once per outage rather than filling the log.
    private void Complain(string message)
    {
        if (complained) return;
        complained = true;
        warn?.Invoke(message);
    }
}
