namespace rPDU2MQTT.Core.Flow;

/// <summary>
/// The period-counter audit: holds every binding's verdict, applies <see cref="PeriodCounterAudit"/>, and
/// persists through <see cref="IPeriodAuditStore"/>.
///
/// <para>
/// Withholding is a correctness decision — it is what keeps a counter that has been contradicted from being
/// published as the day's total — so it is synchronous: the answer has to be in hand before the reading
/// goes anywhere.
/// </para>
/// </summary>
public sealed class PeriodAuditor : IPeriodAuditor
{
    private readonly IPeriodAuditStore store;
    private readonly Dictionary<string, PeriodCounterAudit.State> audit = new(StringComparer.Ordinal);
    private readonly Action<string> warn;
    private readonly object gate = new();
    private readonly Func<bool> mayPersist;

    /// <param name="mayPersist">Whether this process may write the verdicts — false on a standby (#506), which
    /// judges the readings it shows but leaves the shared record to the leader.</param>
    public PeriodAuditor(IPeriodAuditStore store, Action<string>? warn = null, Func<bool>? mayPersist = null)
    {
        this.store = store;
        this.warn = warn ?? (m => Serilog.Log.Warning(m));
        this.mayPersist = mayPersist ?? (() => true);
        foreach (var (k, v) in store.Load()) audit[k] = v;
    }

    /// <summary>Take up the shared record again — on becoming the leader, where the last one left it.</summary>
    public void Reload()
    {
        lock (gate)
        {
            audit.Clear();
            foreach (var (k, v) in store.Load()) audit[k] = v;
        }
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
            if (mayPersist() && (prior is null || next is null
                || prior.PeriodKey != next.PeriodKey || prior.HighWater != next.HighWater || prior.Contradicted != next.Contradicted))
                store.Save(new Dictionary<string, PeriodCounterAudit.State>(audit));

            return allowed;
        }
    }
}
