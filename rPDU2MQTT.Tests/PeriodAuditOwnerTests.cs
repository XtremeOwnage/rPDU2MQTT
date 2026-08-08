using rPDU2MQTT.Core.Flow;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// The audit's verdicts have one owner.
///
/// <para>
/// Held per ingest they were reached twice — the MQTT and Modbus services each kept their own map — and
/// both wrote the whole record back through one store. Each save replaced the hash wholesale, so whichever
/// service saved last erased the other's verdicts. Two replicas would have compounded it.
/// </para>
/// </summary>
public class PeriodAuditOwnerTests : IDisposable
{
    private readonly string path = Path.Combine(Path.GetTempPath(), $"audit-owner-{Guid.NewGuid():N}.json");

    public void Dispose()
    {
        if (File.Exists(path)) File.Delete(path);
        if (File.Exists(path + ".tmp")) File.Delete(path + ".tmp");
    }

    /// <summary>Two independent maps sharing one store — what the ingests did before the owner existed.</summary>
    [Fact]
    public void TwoMapsSharingOneStore_EraseEachOther()
    {
        var store = new FilePeriodAuditStore(path);

        var fromMqtt = new Dictionary<string, PeriodCounterAudit.State>();
        PeriodCounterAudit.Allow(fromMqtt, "2026-08-04", "solar", "sa/pv_energy", "out", 129.9, null);
        store.Save(fromMqtt);

        var fromModbus = new Dictionary<string, PeriodCounterAudit.State>();
        PeriodCounterAudit.Allow(fromModbus, "2026-08-04", "inverter", "register 40 on inv1", "out", 55.0, null);
        store.Save(fromModbus);

        // The second save replaced the record: the MQTT source's history is gone, so its next rollover has
        // nothing to compare against and a cumulative counter passes as honest.
        var reloaded = store.Load();
        Assert.Single(reloaded);
        Assert.DoesNotContain(reloaded.Keys, k => k.StartsWith("solar|"));
    }

    /// <summary>One map behind one owner — both ingests' bindings survive.</summary>
    [Fact]
    public void OneOwnerKeepsBothIngestsVerdicts()
    {
        var store = new FilePeriodAuditStore(path);
        var owned = new Dictionary<string, PeriodCounterAudit.State>();

        PeriodCounterAudit.Allow(owned, "2026-08-04", "solar", "sa/pv_energy", "out", 129.9, null);
        store.Save(owned);
        PeriodCounterAudit.Allow(owned, "2026-08-04", "inverter", "register 40 on inv1", "out", 55.0, null);
        store.Save(owned);

        var reloaded = store.Load();
        Assert.Equal(2, reloaded.Count);
        Assert.Contains(reloaded.Keys, k => k.StartsWith("solar|"));
        Assert.Contains(reloaded.Keys, k => k.StartsWith("inverter|"));
    }

    [Fact]
    public void TheOwnerJudgesBothIngestsIndependently()
    {
        // One map does not mean one verdict: a missed reset on the MQTT binding must not withhold the
        // Modbus one.
        var owned = new Dictionary<string, PeriodCounterAudit.State>();
        bool Allow(string node, string src, double v, string day) =>
            PeriodCounterAudit.Allow(owned, day, node, src, "out", v, null);

        Allow("solar", "sa/pv_energy", 129.9, "2026-08-04");
        Allow("inverter", "register 40 on inv1", 55.0, "2026-08-04");

        Assert.False(Allow("solar", "sa/pv_energy", 130.4, "2026-08-05"));   // no reset
        Assert.True(Allow("inverter", "register 40 on inv1", 0.0, "2026-08-05"));   // reset

        var withheld = Assert.Single(PeriodCounterAudit.WithheldIn(owned));
        Assert.Equal("solar", withheld.Node);
    }
}
