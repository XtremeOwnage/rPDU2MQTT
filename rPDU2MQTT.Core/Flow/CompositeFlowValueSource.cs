namespace rPDU2MQTT.Core.Flow;

/// <summary>
/// Merges several <see cref="IFlowValueSource"/>s into one (#129): the first that has a fresh reading for a
/// (node, metric) wins. Lets the graph draw live values from more than one ingest at once — MQTT and Modbus
/// TCP today — without <see cref="FlowGraphBuilder"/> or any exporter knowing there's more than one source.
/// </summary>
public sealed class CompositeFlowValueSource : IFlowValueSource, IWithheldSources, IFlowValueDiagnostics, IPeriodTotalsReady
{
    private readonly IReadOnlyList<IFlowValueSource> sources;

    public CompositeFlowValueSource(params IFlowValueSource[] sources) => this.sources = sources;

    public bool TryGetValue(string nodeId, string metric, out double value)
    {
        foreach (var s in sources)
            if (s.TryGetValue(nodeId, metric, out value))
                return true;
        value = 0;
        return false;
    }

    /// <summary>
    /// When each reading arrived, from whichever ingest holds it.
    ///
    /// </summary>
    public bool TryDescribe(string nodeId, string metric, out FlowReading reading)
    {
        foreach (var s in sources.OfType<IFlowValueDiagnostics>())
            if (s.TryDescribe(nodeId, metric, out reading))
                return true;
        reading = default;
        return false;
    }

    public IReadOnlyCollection<(string Node, string Metric)> ReportedKeys =>
        sources.OfType<IFlowValueDiagnostics>().SelectMany(s => s.ReportedKeys).Distinct().ToList();

    /// <summary>Ready only when every source behind it is: one that is still restoring holds the rest back.</summary>
    public bool PeriodTotalsReady => sources.OfType<IPeriodTotalsReady>().All(s => s.PeriodTotalsReady);

    /// <summary>
    /// What every ingest behind this one is refusing to publish. Merged here so the GUI asks once and no
    /// caller has to know which transport a binding happens to use — the reason a number is missing is the
    /// same question whichever wire it was meant to arrive on.
    /// </summary>
    public IReadOnlyCollection<WithheldSource> Withheld =>
        sources.OfType<IWithheldSources>().SelectMany(s => s.Withheld).ToList();
}
