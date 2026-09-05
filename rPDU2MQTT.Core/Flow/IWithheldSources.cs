namespace rPDU2MQTT.Core.Flow;

/// <summary>A binding whose readings are being dropped, and why.</summary>
/// <param name="Node">The node it is bound to.</param>
/// <param name="Source">How to find it in the config — an MQTT topic, or a register on a connection.</param>
/// <param name="Metric">The metric it would have fed.</param>
/// <param name="Reason">Plain text, addressed to whoever has to fix it.</param>
/// <param name="Integration">
/// Which ingest is holding it back, as an <c>IIntegration.Id</c>. Stamped by the composite rather than by
/// the ingest itself, which has no reason to know it is one of several. Empty when nothing said.
/// </param>
public readonly record struct WithheldSource(string Node, string Source, string Metric, string Reason,
                                             string Integration = "");

/// <summary>
/// Reports readings the bridge is deliberately refusing to publish.
///
/// <para>
/// Withholding is the right call when a reading can be shown to be wrong — a counter declared as a daily
/// total that never resets is not today's figure, whatever else it is. But a value that quietly vanishes is
/// its own kind of dishonesty: the node reads "no data", which is indistinguishable from a binding nobody
/// ever configured, and the reason lives only in a log line nobody is watching.
/// </para>
/// <para>
/// So the decision has to be visible in the same place the missing number is. This is what the GUI reads to
/// say so.
/// </para>
/// </summary>
public interface IWithheldSources
{
    /// <summary>Every binding currently being withheld. Empty when everything is being believed.</summary>
    IReadOnlyCollection<WithheldSource> Withheld { get; }
}

/// <summary>
/// The port the ingests use to consult the period-counter audit, implemented by whatever owns it.
///
/// <para>
/// Engine talks to this rather than to the owner directly, the same way it takes an
/// <c>ISnapshotSink</c>: the host decides who owns the verdicts, and the ingest
/// neither knows nor needs to.
/// </para>
/// <para>
/// Synchronous because the ingest's message callback is. Only a source declared <c>period</c> reaches it,
/// so an install with none never calls it and it is not on a per-message path.
/// </para>
/// </summary>
public interface IPeriodAuditor
{
    /// <summary>Fold a reading in; false means it may not be published as the day's total.</summary>
    bool Allow(string nodeId, string source, string? direction, string periodKey, double value);

    /// <summary>Every binding currently withheld.</summary>
    IReadOnlyCollection<WithheldSource> Withheld { get; }
}
