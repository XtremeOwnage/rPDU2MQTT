using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Services;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// The audit compares a period against the one before it, so its verdicts have to outlive the process.
/// Held in memory, a restart erased the previous period and every source declared as a daily counter was
/// unproven again — its reading published as today's total until the next rollover.
/// </summary>
public class PeriodAuditStoreTests : IDisposable
{
    private readonly string path = Path.Combine(Path.GetTempPath(), $"period-audit-{Guid.NewGuid():N}.json");

    public void Dispose()
    {
        if (File.Exists(path)) File.Delete(path);
        if (File.Exists(path + ".tmp")) File.Delete(path + ".tmp");
    }

    private sealed class FakeCache : ICacheClient
    {
        public readonly Dictionary<string, Dictionary<string, string>> Data = new();
        public bool Down;
        public IReadOnlyDictionary<string, string> HashGetAll(string key)
        {
            if (Down) throw new InvalidOperationException("cache is not connected");
            return Data.TryGetValue(key, out var h) ? h : new Dictionary<string, string>();
        }
        public bool Ping() => !Down;
        public void HashSet(string key, IReadOnlyDictionary<string, string> fields)
        {
            if (Down) throw new InvalidOperationException("cache is not connected");
            Data[key] = fields.ToDictionary(kv => kv.Key, kv => kv.Value);
        }
    }

    private static Dictionary<string, PeriodCounterAudit.State> Contradicted()
    {
        var audit = new Dictionary<string, PeriodCounterAudit.State>();
        PeriodCounterAudit.Allow(audit, "2026-08-04", "solar", "sa/pv_energy", "out", 129.9, null);
        PeriodCounterAudit.Allow(audit, "2026-08-05", "solar", "sa/pv_energy", "out", 130.4, null);   // no reset
        Assert.Single(PeriodCounterAudit.WithheldIn(audit));
        return audit;
    }

    [Fact]
    public void AVerdictSurvivesAReload_File()
    {
        // The property the store exists for: after a restart the source is still withheld, without waiting
        // for another rollover to catch it out a second time.
        new FilePeriodAuditStore(path).Save(Contradicted());

        var reloaded = new Dictionary<string, PeriodCounterAudit.State>(new FilePeriodAuditStore(path).Load());

        var withheld = Assert.Single(PeriodCounterAudit.WithheldIn(reloaded));
        Assert.Equal("solar", withheld.Node);
        Assert.Contains("did not reset", withheld.Reason);

        // And the next reading is still refused, rather than the source getting a clean slate.
        Assert.False(PeriodCounterAudit.Allow(reloaded, "2026-08-05", "solar", "sa/pv_energy", "out", 131.0, null));
    }

    [Fact]
    public void AVerdictSurvivesAReload_Cache()
    {
        var cache = new FakeCache();
        new RedisPeriodAuditStore(cache, "rpdu2mqtt:").Save(Contradicted());

        // Beside the energy totals, not mixed into them.
        Assert.Contains("rpdu2mqtt:periodaudit", cache.Data.Keys);
        Assert.DoesNotContain("rpdu2mqtt:energy", cache.Data.Keys);

        var reloaded = new Dictionary<string, PeriodCounterAudit.State>(new RedisPeriodAuditStore(cache, "rpdu2mqtt:").Load());
        Assert.Single(PeriodCounterAudit.WithheldIn(reloaded));
    }

    [Fact]
    public void AHighWaterMarkSurvives_SoTheNextRolloverCanStillJudge()
    {
        // Restarting mid-period must not lose the peak: without it the next rollover has nothing to compare
        // against and a cumulative counter passes as honest.
        var audit = new Dictionary<string, PeriodCounterAudit.State>();
        PeriodCounterAudit.Allow(audit, "2026-08-04", "solar", "sa/pv_energy", "out", 129.9, null);
        new FilePeriodAuditStore(path).Save(audit);

        var reloaded = new Dictionary<string, PeriodCounterAudit.State>(new FilePeriodAuditStore(path).Load());

        Assert.False(PeriodCounterAudit.Allow(reloaded, "2026-08-05", "solar", "sa/pv_energy", "out", 130.4, null));
    }

    [Fact]
    public void AnUnreadableStoreLeavesEverythingUnproven_RatherThanThrowing()
    {
        // Degrading to the previous behaviour is acceptable; taking the ingest down is not.
        File.WriteAllText(path, "{ this is not json");
        var warnings = new List<string>();

        var loaded = new FilePeriodAuditStore(path, warnings.Add).Load();

        Assert.Empty(loaded);
        Assert.Single(warnings);
    }

    [Fact]
    public void AnUnreachableCacheLoadsEmptyAndSaysSoOnce()
    {
        var cache = new FakeCache { Down = true };
        var warnings = new List<string>();
        var store = new RedisPeriodAuditStore(cache, "rpdu2mqtt:", warnings.Add);

        Assert.Empty(store.Load());
        store.Save(Contradicted());
        store.Save(Contradicted());

        Assert.Single(warnings);   // one per outage, not one per attempt
    }

    [Fact]
    public void OneUnreadableFieldDoesNotDiscardTheRest()
    {
        var cache = new FakeCache();
        new RedisPeriodAuditStore(cache, "p:").Save(Contradicted());
        cache.Data["p:periodaudit"]["broken|x|out"] = "{{{";

        var loaded = new RedisPeriodAuditStore(cache, "p:").Load();

        Assert.Single(loaded);
    }
}
