namespace rPDU2MQTT.Core.Flow;

/// <summary>One cached reading, with enough context to judge whether it can still be believed.</summary>
/// <param name="Value">The reading, in the metric's canonical unit.</param>
/// <param name="AtUtc">When it arrived.</param>
/// <param name="StaleAfterSeconds">How long it stays valid; 0 means it never expires.</param>
/// <param name="Fresh">Whether it is still within that window right now.</param>
public readonly record struct FlowReading(double Value, DateTime AtUtc, int StaleAfterSeconds, bool Fresh);

/// <summary>
/// Optional companion to <see cref="IFlowValueSource"/>: reports not just a value but <i>when</i> it
/// arrived and whether it has expired.
/// </summary>
public interface IFlowValueDiagnostics
{
    /// <summary>The reading held for this (node, metric), fresh or stale. False when there is none at all.</summary>
    bool TryDescribe(string nodeId, string metric, out FlowReading reading);

    /// <summary>Every (node, metric) pair currently held, so a UI can show what has ever reported.</summary>
    IReadOnlyCollection<(string Node, string Metric)> ReportedKeys { get; }
}

/// <summary>
/// Whether the daily totals this source derives have been restored from the store yet.
/// </summary>
public interface IPeriodTotalsReady
{
    bool PeriodTotalsReady { get; }
}
