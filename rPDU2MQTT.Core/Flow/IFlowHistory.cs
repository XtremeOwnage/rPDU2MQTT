namespace rPDU2MQTT.Core.Flow;

/// <summary>
/// Reads what a set of flow nodes read at a past instant (#372).
///
/// <para>
/// One method, because that is the whole question a dashboard asks of history: the values at a moment. The
/// diagram is then built from those exactly as it is built from live ones — same builder, same roll-up,
/// same rules about what is unknown — so a historical view cannot drift from the live one.
/// </para>
/// <para>
/// A node the backend has nothing for is <b>absent</b> from the result, never zero. The builder reads an
/// absent node as unmeasured and says so; a zero would be a reading nobody took.
/// </para>
/// </summary>
public interface IFlowHistory
{
    /// <summary>Which backend this is, as named in config ("prometheus", "emoncms").</summary>
    string Id { get; }

    /// <summary>
    /// The value each node held at <paramref name="atUtc"/>, keyed by node id. Nodes with no data are
    /// omitted.
    /// </summary>
    Task<IReadOnlyDictionary<string, double>> ValuesAtAsync(
        IReadOnlyCollection<string> nodeIds, string metric, DateTime atUtc, CancellationToken ct);
}

/// <summary>
/// A point-in-time answer dressed as the live source, so <see cref="FlowGraphBuilder"/> needs no notion of
/// history at all: it asks the same question and gets the values for that instant.
/// </summary>
public sealed class HistoricalFlowValueSource : IFlowValueSource
{
    private readonly IReadOnlyDictionary<string, double> values;
    private readonly string metric;

    /// <param name="values">Node id -> value, for one metric.</param>
    /// <param name="metric">The metric those values are in. A request for any other metric finds nothing.</param>
    public HistoricalFlowValueSource(IReadOnlyDictionary<string, double> values, string metric)
    {
        this.values = values;
        this.metric = metric;
    }

    public bool TryGetValue(string nodeId, string metric, out double value)
    {
        value = 0;
        // Answering a metric these values are not in would hand the power roll-up an energy figure.
        if (!string.Equals(metric, this.metric, StringComparison.OrdinalIgnoreCase)) return false;
        return values.TryGetValue(nodeId, out value);
    }
}
