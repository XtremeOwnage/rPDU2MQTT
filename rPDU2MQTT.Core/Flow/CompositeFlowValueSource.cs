namespace rPDU2MQTT.Core.Flow;

/// <summary>
/// Merges several <see cref="IFlowValueSource"/>s into one (#129): the first that has a fresh reading for a
/// (node, metric) wins. Lets the graph draw live values from more than one ingest at once — MQTT and Modbus
/// TCP today — without <see cref="FlowGraphBuilder"/> or any exporter knowing there's more than one source.
/// </summary>
public sealed class CompositeFlowValueSource : IFlowValueSource, IWithheldSources
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
    /// What every ingest behind this one is refusing to publish. Merged here so the GUI asks once and no
    /// caller has to know which transport a binding happens to use — the reason a number is missing is the
    /// same question whichever wire it was meant to arrive on.
    /// </summary>
    public IReadOnlyCollection<WithheldSource> Withheld =>
        sources.OfType<IWithheldSources>().SelectMany(s => s.Withheld).ToList();
}
