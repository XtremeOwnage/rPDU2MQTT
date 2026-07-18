namespace rPDU2MQTT.Core.Flow;

/// <summary>
/// Merges several <see cref="IFlowValueSource"/>s into one (#129): the first that has a fresh reading for a
/// (node, metric) wins. Lets the graph draw live values from more than one ingest at once — MQTT and Modbus
/// TCP today — without <see cref="FlowGraphBuilder"/> or any exporter knowing there's more than one source.
/// </summary>
public sealed class CompositeFlowValueSource : IFlowValueSource
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
}
