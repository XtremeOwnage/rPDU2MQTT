namespace rPDU2MQTT.Core.Flow;

/// <summary>
/// The period-counter audit: holds every binding's verdict, applies <see cref="PeriodCounterAudit"/>, and
/// persists through <see cref="IPeriodAuditStore"/>.
///
/// <para>
/// Withholding is a correctness decision — it is what keeps a counter that has been contradicted from being
/// published as the day's total — so the answer has to be given before the reading goes anywhere. That is
/// why this is synchronous: it used to be a grain call blocked on with <c>GetAwaiter().GetResult()</c>,
/// which is the same thing with a round trip in the middle.
/// </para>
/// </summary>
public sealed class PeriodAuditor : IPeriodAuditor
{
    private readonly IPeriodAuditStore store;
    private readonly Dictionary<string, PeriodCounterAudit.State> audit = new(StringComparer.Ordinal);
    private readonly Action<string> warn;
    private readonly object gate = new();

    public PeriodAuditor(IPeriodAuditStore store, Action<string>? warn = null)
    {
        this.store = store;
        this.warn = warn ?? (m => Serilog.Log.Warning(m));
        foreach (var (k, v) in store.Load()) audit[k] = v;
    }

    public IReadOnlyCollection<WithheldSource> Withheld
    {
        get
        {
            lock (gate)
                return PeriodCounterAudit.WithheldIn(audit)
                    .Select(w => new WithheldSource(w.Node, w.Source, w.Metric, w.Reason))
                    .ToList();
        }
    }

    public bool Allow(string nodeId, string source, string? direction, string periodKey, double value)
    {
        lock (gate)
        {
            var key = $"{nodeId}|{source}|{direction}";
            audit.TryGetValue(key, out var prior);
            var allowed = PeriodCounterAudit.Allow(audit, periodKey, nodeId, source, direction, value, warn);

            // Only when something moved. The high-water mark changes on most readings, and the store is a
            // file or a cache round-trip.
            var next = audit.TryGetValue(key, out var after) ? after : null;
            if (prior is null || next is null
                || prior.PeriodKey != next.PeriodKey || prior.HighWater != next.HighWater || prior.Contradicted != next.Contradicted)
                store.Save(new Dictionary<string, PeriodCounterAudit.State>(audit));

            return allowed;
        }
    }
}
