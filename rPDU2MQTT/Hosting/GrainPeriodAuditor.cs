using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Grains.Abstractions.Flow;

namespace rPDU2MQTT.Hosting;

/// <summary>
/// Points the ingests' audit port at the grain that owns the verdicts.
///
/// <para>
/// The host decides that the owner is a single activation; Engine only knows there is one. That is the
/// same split as <c>ISnapshotSink</c>, and it is what keeps the grain reference out of the transport
/// layer.
/// </para>
/// </summary>
public sealed class GrainPeriodAuditor(IGrainFactory grains) : IPeriodAuditor
{
    private volatile WithheldSource[] withheld = [];

    public IReadOnlyCollection<WithheldSource> Withheld => withheld;

    public bool Allow(string nodeId, string source, string? direction, string periodKey, double value)
    {
        var grain = grains.GetGrain<IPeriodAuditGrain>(0);
        // Blocking on the grain is acceptable here and nowhere near a per-message path: only a source
        // declared 'period' reaches this, and withholding is a correctness decision, so the reading cannot
        // be published while the answer is still outstanding.
        var allowed = grain.Allow(nodeId, source, direction, periodKey, value).GetAwaiter().GetResult();
        withheld = [.. grain.Withheld().GetAwaiter().GetResult()
            .Select(w => new WithheldSource(w.Node, w.Source, w.Metric, w.Reason))];
        return allowed;
    }
}
