using System.ComponentModel;

namespace rPDU2MQTT.Models.Config;

/// <summary>
/// A shared Redis/Valkey cache.
///
/// <para>
/// Introduced for the energy accumulator — a cumulative counter that must survive restarts, since
/// consumers read a drop as a meter reset and correct their recorded history for it. It is deliberately a
/// general cache rather than an energy-specific store: one lightweight instance can back anything else
/// that needs shared or durable state, and several replicas then agree instead of each keeping its own.
/// </para>
/// <para>
/// Optional. With this disabled the accumulator falls back to a local state file, which is correct for a
/// single process but cannot be shared between replicas.
/// </para>
/// </summary>
public class CacheConfig
{
    [DefaultValue(false)]
    [Description("Use a Redis/Valkey instance for shared, durable state (today: the energy accumulator).")]
    public bool Enabled { get; set; }

    [DefaultValue("localhost:6379")]
    [Description("Redis/Valkey endpoint, host:port. A full StackExchange.Redis connection string also works, e.g. \"valkey:6379,ssl=false\".")]
    public string Connection { get; set; } = "localhost:6379";

    [Description("Password, if the instance requires one. Leave blank for an unauthenticated instance on a trusted network.")]
    public string? Password { get; set; }

    [DefaultValue("rpdu2mqtt:")]
    [Description("Prefix for every key written, so the instance can be shared with other applications.")]
    public string KeyPrefix { get; set; } = "rpdu2mqtt:";

    [DefaultValue(5)]
    [Description("Seconds to wait when connecting before falling back to local state.")]
    public int ConnectTimeoutSeconds { get; set; } = 5;
}
