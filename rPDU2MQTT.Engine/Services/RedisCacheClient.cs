using StackExchange.Redis;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Models.Config;

namespace rPDU2MQTT.Services;

/// <summary>
/// The StackExchange.Redis adapter behind <see cref="ICacheClient"/>, and the shared connection.
///
/// <para>
/// The connection is lazy and non-throwing: the bridge must start and keep polling whether or not the
/// cache is up, so a missing instance degrades to local state instead of failing startup. AbortOnConnectFail
/// is off so the client keeps retrying in the background and recovers on its own.
/// </para>
/// <para>
/// One instance, registered once — anything else needing shared state uses the same connection rather than
/// opening another.
/// </para>
/// </summary>
public sealed class RedisCacheClient : ICacheClient, Core.Integrations.ILeaseStore, IDisposable
{
    private readonly Lazy<ConnectionMultiplexer?> connection;
    private readonly CacheHealth health;

    public RedisCacheClient(CacheConfig cfg, CacheHealth health)
    {
        this.health = health;
        connection = new Lazy<ConnectionMultiplexer?>(() =>
        {
            var options = ConfigurationOptions.Parse(cfg.Connection);
            // Keep trying in the background instead of throwing on the first failed connect.
            options.AbortOnConnectFail = false;
            options.ConnectTimeout = Math.Max(1, cfg.ConnectTimeoutSeconds) * 1000;
            if (!string.IsNullOrWhiteSpace(cfg.Password)) options.Password = cfg.Password;
            return ConnectionMultiplexer.Connect(options);
        });
    }

    private IDatabase? Db => connection.Value is { IsConnected: true } c ? c.GetDatabase() : null;

    public IReadOnlyDictionary<string, string> HashGetAll(string key)
    {
        try
        {
            var db = Db ?? throw new InvalidOperationException("cache is not connected");
            var result = db.HashGetAll(key).ToDictionary(e => e.Name.ToString(), e => e.Value.ToString());
            health.Succeeded();
            return result;
        }
        catch (Exception ex) { health.Failed(ex.Message); throw; }
    }

    public void HashSetField(string key, string field, string value)
    {
        try
        {
            var db = Db ?? throw new InvalidOperationException("cache is not connected");
            db.HashSet(key, field, value);   // HSET: merges, and leaves every other field where it is
            health.Succeeded();
        }
        catch (Exception ex) { health.Failed(ex.Message); throw; }
    }

    public void HashSet(string key, IReadOnlyDictionary<string, string> fields)
    {
        try
        {
            var db = Db ?? throw new InvalidOperationException("cache is not connected");
            // Replace wholesale: a node removed from the config must not leave its total behind forever.
            var tx = db.CreateTransaction();
            _ = tx.KeyDeleteAsync(key);
            _ = tx.HashSetAsync(key, fields.Select(kv => new HashEntry(kv.Key, kv.Value)).ToArray());
            tx.Execute();
            health.Succeeded();
        }
        catch (Exception ex) { health.Failed(ex.Message); throw; }
    }

    /// <summary>
    /// A real round-trip, not just IsConnected: the multiplexer reports connected while a half-open
    /// socket is still being reaped, and the Status board should say what the cache is doing now.
    /// </summary>
    public bool Ping()
    {
        try
        {
            var db = Db ?? throw new InvalidOperationException("cache is not connected");
            db.Ping();
            health.Succeeded();
            return true;
        }
        catch (Exception ex) { health.Failed(ex.Message); return false; }
    }

    // Extend or delete only when the value is still ours: a GET then PEXPIRE could act on a lease another
    // process took in between, which is the one thing a lease exists to prevent.
    private const string RenewScript =
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";
    private const string ReleaseScript =
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

    public bool TryAcquire(string key, string owner, TimeSpan ttl)
    {
        var db = Db ?? throw new InvalidOperationException("cache is not connected");
        return db.StringSet(key, owner, ttl, When.NotExists);
    }

    public bool Renew(string key, string owner, TimeSpan ttl)
    {
        var db = Db ?? throw new InvalidOperationException("cache is not connected");
        return (long)db.ScriptEvaluate(RenewScript, [key], [owner, (long)ttl.TotalMilliseconds]) == 1;
    }

    public void Release(string key, string owner)
    {
        var db = Db ?? throw new InvalidOperationException("cache is not connected");
        db.ScriptEvaluate(ReleaseScript, [key], [owner]);
    }

    public string? Holder(string key)
    {
        var db = Db ?? throw new InvalidOperationException("cache is not connected");
        var v = db.StringGet(key);
        return v.HasValue ? v.ToString() : null;
    }

    public void Dispose() { if (connection.IsValueCreated) connection.Value?.Dispose(); }
}
