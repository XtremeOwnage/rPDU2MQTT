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
    /// <summary>
    /// One reading per node at each of <paramref name="steps"/>.
    ///
    /// <para>
    /// A chart asks for tens or hundreds of moments at once, and asking for them one at a time is a
    /// timeout rather than a chart — six hours at five-minute resolution is 72 round trips. A backend that
    /// can answer a range in one request overrides this; the default keeps the seam honest for one that
    /// cannot.
    /// </para>
    /// <para>
    /// A step with no reading is an absent entry, never a carried-forward value: a flat line drawn through
    /// a gap cannot be told from a reading that genuinely did not change.
    /// </para>
    /// </summary>
    async Task<IReadOnlyList<IReadOnlyDictionary<string, double>>> SeriesAsync(
        IReadOnlyCollection<string> nodeIds, string metric, IReadOnlyList<DateTime> steps, CancellationToken ct)
    {
        var out_ = new List<IReadOnlyDictionary<string, double>>(steps.Count);
        foreach (var at in steps) out_.Add(await ValuesAtAsync(nodeIds, metric, at, ct));
        return out_;
    }

    Task<IReadOnlyDictionary<string, double>> ValuesAtAsync(
        IReadOnlyCollection<string> nodeIds, string metric, DateTime atUtc, CancellationToken ct);

    /// <summary>
    /// Is the backend answering? Reported on the Status board, so a history source that cannot be reached
    /// says so there rather than only when someone picks a date and gets nothing.
    /// </summary>
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
        // Answering a metric these values are not in would hand the power roll-up an energy figure.
        if (!string.Equals(metric, this.metric, StringComparison.OrdinalIgnoreCase)) return false;
        return values.TryGetValue(nodeId, out value);
    }
}
