using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Services;

namespace rPDU2MQTT.Tests;

/// <summary>
/// Whether today's figures actually cover today.
///
/// <para>
/// The accumulator keeps each node's energy since the period boundary, and that state has to outlive the
/// process. When it does not — an empty store, or nowhere durable to keep it — the figures start again, and
/// a tile reading "0 kWh since the day rolled over" is a claim about a day nobody measured. On a tile it is
/// indistinguishable from a solar array at night.
/// </para>
/// </summary>
public class PeriodTotalsOriginTests
{
    private sealed class Store : IEnergyStore
    {
        private readonly Dictionary<string, EnergyState> held;
        public Store(Dictionary<string, EnergyState>? held = null) => this.held = held ?? new();
        public IReadOnlyDictionary<string, EnergyState> Load() => held;
        public void Save(IReadOnlyDictionary<string, EnergyState> states) { }
    }

    private static EnergyAggregationService Service(IEnergyStore store)
    {
        var cfg = new Config();
        cfg.EnergyFlow.Aggregation.TrackPeriods = true;
        return new EnergyAggregationService(cfg, new MemoryFlowValueSource(), store);
    }

    private sealed class MemoryFlowValueSource : IFlowValueSource
    {
        public bool TryGetValue(string nodeId, string metric, out double value) { value = 0; return false; }
    }

    [Fact]
    public void AnEmptyStoreIsReportedAsNothingCarriedOver()
    {
        var svc = Service(new Store());

        svc.LoadTotals();

        Assert.Equal(0, svc.CarriedOverNodes);
        Assert.True(svc.AccumulatingSinceUtc > DateTime.UtcNow.AddMinutes(-1),
            "with nothing carried over the figures start now, and that instant is what the GUI shows");
    }

    [Fact]
    public void CarriedStateIsCounted()
    {
        var svc = Service(new Store(new()
        {
            ["solar"] = new EnergyState(42, DateTime.UtcNow, 0, 0, "2026-08-24", 10),
            ["grid"] = new EnergyState(8, DateTime.UtcNow, 0, 0, "2026-08-24", 1),
        }));

        Assert.Equal(2, svc.LoadTotals());
        Assert.Equal(2, svc.CarriedOverNodes);
    }

    /// <summary>The store is named so the fix for losing it is obvious from the message.</summary>
    [Fact]
    public void TheStoreIsNamed()
    {
        Assert.Equal("file", Service(new FileEnergyStore(Path.GetTempFileName())).StoreKind);
        Assert.Equal("memory", Service(new Store()).StoreKind);
    }
}
