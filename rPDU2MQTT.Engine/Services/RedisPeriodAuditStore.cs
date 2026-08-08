using System.Text.Json;
using rPDU2MQTT.Core.Flow;

namespace rPDU2MQTT.Services;

/// <summary>
/// The period-counter audit's verdicts in Redis/Valkey, in a hash beside the energy totals.
///
/// <para>
/// Shared across replicas as well as across restarts: the verdict is about a source, not about a process,
/// so two replicas reading the same broker should reach the same conclusion rather than each learning it
/// separately at the next rollover.
/// </para>
/// <para>
/// An unreachable instance reports empty and says so rather than throwing. The caller then treats every
/// source as unproven, which is the behaviour before this store existed.
/// </para>
/// </summary>
public sealed class RedisPeriodAuditStore : IPeriodAuditStore
{
    private readonly ICacheClient cache;
    private readonly string key;
    private readonly Action<string>? warn;
    private bool complained;

    public RedisPeriodAuditStore(ICacheClient cache, string keyPrefix, Action<string>? warn = null)
    {
        this.cache = cache;
        this.key = (keyPrefix ?? "") + "periodaudit";
        this.warn = warn;
    }

    public IReadOnlyDictionary<string, PeriodCounterAudit.State> Load()
    {
        var states = new Dictionary<string, PeriodCounterAudit.State>();
        try
        {
            foreach (var (source, json) in cache.HashGetAll(key))
            {
                // One unreadable field must not discard every other source's verdict.
                try
                {
                    if (JsonSerializer.Deserialize<PeriodCounterAudit.State>(json) is { } s) states[source] = s;
                }
                catch (JsonException ex)
                {
                    warn?.Invoke($"Period-counter audit for '{source}' in {key} is unreadable ({ex.Message}); "
                               + "that source is unproven until the next rollover.");
                }
            }
        }
        catch (Exception ex)
        {
            Complain($"Could not read the period-counter audit from the cache ({ex.Message}). Sources declared as "
                   + "daily counters are unproven for this run.");
        }
        return states;
    }

    public void Save(IReadOnlyDictionary<string, PeriodCounterAudit.State> states)
    {
        try
        {
            cache.HashSet(key, states.ToDictionary(kv => kv.Key, kv => JsonSerializer.Serialize(kv.Value)));
            complained = false;
        }
        catch (Exception ex)
        {
            Complain($"Could not write the period-counter audit to the cache ({ex.Message}). The verdicts hold in "
                   + "memory, but a restart before it recovers loses them.");
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
