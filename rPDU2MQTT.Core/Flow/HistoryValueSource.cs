using rPDU2MQTT.Classes;

namespace rPDU2MQTT.Core.Flow;

/// <summary>
/// A history backend read as a live source: whatever it stored most recently is offered as the current
/// value for a node that has nothing fresher.
///
/// <para>
/// This is what makes "EmonCMS as a source" and "Prometheus as a source" the existing history providers
/// rather than new implementations. A destination writes a series; the same integration can read it back;
/// and a node with no direct binding can therefore be valued from what was last recorded about it —
/// useful when the thing that measures a node publishes somewhere this bridge already reads.
/// </para>
/// <para>
/// Placed LAST in the composite, always. It is a fallback for a node nothing live reports, never a
/// substitute for one: a value read back from storage is by definition older than one from an ingest, and
/// preferring it would quietly replace live readings with their own echo.
/// </para>
/// </summary>
public sealed class HistoryValueSource : IFlowValueSource, IDisposable
{
    private readonly IMeasurementHistory history;
    private readonly Config cfg;
    private readonly Func<IReadOnlyCollection<string>> nodesToRead;
    private readonly TimeSpan refresh;

    // metric -> node -> value, refreshed on a timer. Reads are synchronous (the graph builder asks a
    // question and expects an answer), so the fetching cannot happen inline.
    private readonly Dictionary<string, IReadOnlyDictionary<string, double>> byMetric = new(StringComparer.OrdinalIgnoreCase);
    private readonly SemaphoreSlim gate = new(1, 1);
    private DateTime fetchedAt = DateTime.MinValue;
    private Timer? timer;

    /// <param name="nodesToRead">
    /// Which nodes to ask about. A function rather than a list so it follows configuration changes, and so
    /// a caller can narrow it — asking a backend about every node on every refresh is a query per node on
    /// some of them.
    /// </param>
    public HistoryValueSource(
        IMeasurementHistory history, Config cfg, Func<IReadOnlyCollection<string>> nodesToRead, TimeSpan? refresh = null)
    {
        this.history = history;
        this.cfg = cfg;
        this.nodesToRead = nodesToRead;
        this.refresh = refresh ?? TimeSpan.FromSeconds(60);
    }

    /// <summary>Begin refreshing. Until the first fetch completes this source simply has nothing.</summary>
    public void Start()
        => timer ??= new Timer(async _ => await RefreshAsync(CancellationToken.None), null, TimeSpan.Zero, refresh);

    public bool TryGetValue(string nodeId, string metric, out double value)
    {
        value = 0;
        // Nothing fetched yet, or the last fetch is older than two refreshes: report nothing rather than a
        // stale number. Unknown is not a value, and an old one presented as current is worse than none.
        if (byMetric.Count == 0 || DateTime.UtcNow - fetchedAt > refresh * 2) return false;
        return byMetric.TryGetValue(metric, out var nodes) && nodes.TryGetValue(nodeId, out value);
    }

    /// <summary>Fetch the latest stored value for every node being read. Public so a test can drive it.</summary>
    public async Task RefreshAsync(CancellationToken ct)
    {
        if (!await gate.WaitAsync(0, ct)) return;   // a slow backend must not queue refreshes behind itself
        try
        {
            var nodes = nodesToRead();
            if (nodes.Count == 0) return;

            var now = DateTime.UtcNow;
            var fetched = new Dictionary<string, IReadOnlyDictionary<string, double>>(StringComparer.OrdinalIgnoreCase);
            foreach (var metric in FlowTiers.Metrics(cfg))
                fetched[metric] = await history.ValuesAtAsync(nodes, metric, now, ct);

            foreach (var (metric, values) in fetched) byMetric[metric] = values;
            fetchedAt = now;
        }
        catch (Exception ex)
        {
            // A backend that cannot be read leaves the previous values to age out of TryGetValue above,
            // rather than clearing them mid-poll and making every node blink to unknown.
            Serilog.Log.Debug($"History value source refresh failed: {ex.Message}");
        }
        finally { gate.Release(); }
    }

    public void Dispose()
    {
        timer?.Dispose();
        gate.Dispose();
    }
}
