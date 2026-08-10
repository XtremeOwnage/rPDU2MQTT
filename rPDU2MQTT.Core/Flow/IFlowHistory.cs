namespace rPDU2MQTT.Core.Flow;

/// <summary>
/// Reads what a set of flow nodes read at a past instant (#372).
/// </summary>
public interface IFlowHistory
{
    /// <summary>Which backend this is, as named in config ("prometheus", "emoncms").</summary>
    string Id { get; }

    /// <summary>One reading per node at each of <paramref name="steps"/>.</summary>
    async Task<IReadOnlyList<IReadOnlyDictionary<string, double>>> SeriesAsync(
        IReadOnlyCollection<string> nodeIds, string metric, IReadOnlyList<DateTime> steps, CancellationToken ct)
    {
        var out_ = new List<IReadOnlyDictionary<string, double>>(steps.Count);
        foreach (var at in steps) out_.Add(await ValuesAtAsync(nodeIds, metric, at, ct));
        return out_;
    }

    /// <summary>The value each node held at <paramref name="atUtc"/>; nodes with no data are omitted.</summary>
    Task<IReadOnlyDictionary<string, double>> ValuesAtAsync(
        IReadOnlyCollection<string> nodeIds, string metric, DateTime atUtc, CancellationToken ct);

    /// <summary>Is the backend answering? Reported on the Status board.</summary>
    Task<(bool Ok, string Detail)> ProbeAsync(CancellationToken ct);
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

        // The in-direction is asked for as a metric suffix (energytoday#in) but stored as a node of its own.
        if (metric.EndsWith(FlowMetricKey.InSuffix, StringComparison.Ordinal))
        {
            var baseMetric = metric[..^FlowMetricKey.InSuffix.Length];
            if (!string.Equals(baseMetric, this.metric, StringComparison.OrdinalIgnoreCase)) return false;
            return values.TryGetValue(nodeId + FlowMetricKey.InSuffix, out value);
        }

        // Answering a metric these values are not in would hand the power roll-up an energy figure.
        if (!string.Equals(metric, this.metric, StringComparison.OrdinalIgnoreCase)) return false;
        return values.TryGetValue(nodeId, out value);
    }
}
