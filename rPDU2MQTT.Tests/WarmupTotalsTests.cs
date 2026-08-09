using rPDU2MQTT.Core.Flow;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// A daily total that has not been worked out yet is not a daily total of zero.
///
/// <para>
/// The carried-over totals live in a store so a restart continues rather than starts again, and the restore
/// is not instant. In that window a leaf correctly has no period figure, but an aggregate over those leaves
/// still resolves — from links that are known and carry zero — so the tier scrapes as a confident 0 for a
/// day nobody has added up yet. On a cluster that rolls this workload every few minutes, those zeros are
/// written into the history backend permanently, and every chart built on them is wrong.
/// </para>
/// </summary>
public class WarmupTotalsTests
{
    private sealed class Restoring : IFlowValueSource, IPeriodTotalsReady
    {
        public bool PeriodTotalsReady { get; set; }
        public bool TryGetValue(string node, string metric, out double value) { value = 0; return false; }
    }

    private sealed class Plain : IFlowValueSource
    {
        public bool TryGetValue(string node, string metric, out double value) { value = 0; return false; }
    }

    [Fact]
    public void ACompositeIsReadyOnlyWhenEverySourceIs()
    {
        var restoring = new Restoring { PeriodTotalsReady = false };
        var composite = new CompositeFlowValueSource(new Plain(), restoring);

        Assert.False(((IPeriodTotalsReady)composite).PeriodTotalsReady);

        restoring.PeriodTotalsReady = true;
        Assert.True(((IPeriodTotalsReady)composite).PeriodTotalsReady);
    }

    [Fact]
    public void ASourceThatDoesNotTrackTotalsDoesNotHoldTheRestBack()
    {
        // The interface is opt-in: a source with no period totals of its own has nothing to restore, and
        // must not make the export wait forever.
        var composite = new CompositeFlowValueSource(new Plain(), new Plain());

        Assert.True(((IPeriodTotalsReady)composite).PeriodTotalsReady);
    }

    [Fact]
    public void TheAggregatorIsNotReadyUntilItHasLoaded()
    {
        // The property the gate is built on. Reported ready before the store is read, the gate is a no-op
        // and the warm-up zeros go out exactly as before.
        var cfg = new rPDU2MQTT.Classes.Config();
        cfg.EnergyFlow.Aggregation.TrackPeriods = true;
        var svc = new rPDU2MQTT.Services.EnergyAggregationService(cfg, new Plain(), new NoStore());

        Assert.False(svc.PeriodTotalsReady);

        svc.LoadTotals();

        Assert.True(svc.PeriodTotalsReady);
    }

    [Fact]
    public void WithoutPeriodTrackingThereIsNothingToWaitFor()
    {
        var cfg = new rPDU2MQTT.Classes.Config();
        cfg.EnergyFlow.Aggregation.TrackPeriods = false;
        var svc = new rPDU2MQTT.Services.EnergyAggregationService(cfg, new Plain(), new NoStore());

        Assert.True(svc.PeriodTotalsReady);
    }

    private sealed class NoStore : IEnergyStore
    {
        public IReadOnlyDictionary<string, EnergyState> Load() => new Dictionary<string, EnergyState>();
        public void Save(IReadOnlyDictionary<string, EnergyState> states) { }
    }

    [Fact]
    public void NoDailyTotalGoesOutWhileTheTotalsAreStillBeingRestored()
    {
        // Home Assistant records what MQTT publishes. A daily total dropping to zero reads there as a meter
        // reset, and HA corrects history that was already right — so the seconds before the restore have to
        // publish nothing rather than a zero.
        var graph = new FlowGraph(
            [new FlowNode("panel", "Panel", "panel", 12.5)], [], EnergyPeriod.Metric, "kWh");

        Assert.Null(FlowExport.PeriodTotal(graph, "panel", periodTotalsReady: false));
        Assert.Equal(12.5, FlowExport.PeriodTotal(graph, "panel", periodTotalsReady: true));
    }

    [Fact]
    public void AnUnknownTierIsStillNullOnceReady()
    {
        var graph = new FlowGraph([new FlowNode("panel", "Panel", "panel")], [], EnergyPeriod.Metric, "kWh");

        Assert.Null(FlowExport.PeriodTotal(graph, "panel", periodTotalsReady: true));
        Assert.Null(FlowExport.PeriodTotal(graph, "missing", periodTotalsReady: true));
    }

    [Fact]
    public void TheLiveSourceTheExportersAreGivenCanBeAsked()
    {
        // Structural: the exporters hold a composite, so the gate only works if the composite offers it —
        // the same way the reading-age diagnostics were lost by not being forwarded.
        Assert.True(typeof(IPeriodTotalsReady).IsAssignableFrom(typeof(CompositeFlowValueSource)));
    }
}
