using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Grains.Abstractions.Flow;

namespace rPDU2MQTT.Grains.Flow;

/// <summary>
/// The period-counter audit's single owner. Holds every binding's verdict, applies
/// <see cref="PeriodCounterAudit"/>, and persists through <see cref="IPeriodAuditStore"/>.
/// </summary>
public sealed class PeriodAuditGrain : Grain, IPeriodAuditGrain
{
    private readonly IPeriodAuditStore store;
    private readonly Dictionary<string, PeriodCounterAudit.State> audit = new(StringComparer.Ordinal);
    private readonly Action<string> warn;

    public PeriodAuditGrain(IPeriodAuditStore store)
    {
        this.store = store;
        warn = m => Serilog.Log.Warning(m);
    }

    public override Task OnActivateAsync(CancellationToken ct)
    {
        foreach (var (k, v) in store.Load()) audit[k] = v;
        return base.OnActivateAsync(ct);
    }

    public Task<bool> Allow(string nodeId, string source, string? direction, string periodKey, double value)
    {
        var key = $"{nodeId}|{source}|{direction}";
        audit.TryGetValue(key, out var prior);
        var allowed = PeriodCounterAudit.Allow(audit, periodKey, nodeId, source, direction, value, warn);

        // Only when something moved. The high-water mark changes on most readings, and the store is a file
        // or a cache round-trip.
        var next = audit.TryGetValue(key, out var after) ? after : null;
        if (prior is null || next is null
            || prior.PeriodKey != next.PeriodKey || prior.HighWater != next.HighWater || prior.Contradicted != next.Contradicted)
            store.Save(new Dictionary<string, PeriodCounterAudit.State>(audit));

        return Task.FromResult(allowed);
    }

    public Task<List<(string Node, string Source, string Metric, string Reason)>> Withheld()
        => Task.FromResult(PeriodCounterAudit.WithheldIn(audit)
            .Select(w => (w.Node, w.Source, w.Metric, w.Reason)).ToList());
}
