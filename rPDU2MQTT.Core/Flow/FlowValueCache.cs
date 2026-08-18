using System.Collections.Concurrent;

namespace rPDU2MQTT.Core.Flow;

/// <summary>
/// Holds the newest externally-reported value per (node, metric) and expires it once the publisher goes
/// quiet (#205). Kept free of any transport so the staleness rules are testable on their own; the MQTT
/// ingest (<c>EnergyFlowMqttSourceService</c>) is just one writer, and a future CT-clamp or inverter
/// poller can share it.
/// </summary>
public sealed class FlowValueCache : IFlowValueSource, IFlowValueDiagnostics, IWithheldSources
{
    private sealed record Reading(double Value, DateTime AtUtc, int StaleAfterSeconds);

    // Written from broker callbacks, read by the exporters/GUI — hence concurrent.
    private readonly ConcurrentDictionary<(string Node, string Metric), Reading> latest = new();

    // Sources that sign their readings — negative for export or discharge — on a metric that only flows
    // one way. Kept so the GUI can say so, because the graph has to clamp it and a silent clamp turns a
    // meter running backwards into a load drawing nothing.
    private readonly ConcurrentDictionary<(string Node, string Metric), double> signed = new();

    /// <summary>Record a reading. <paramref name="staleAfterSeconds"/> of 0 means it never expires.</summary>
    public void Set(string nodeId, string metric, double value, int staleAfterSeconds, DateTime nowUtc)
    {
        latest[(nodeId, metric)] = new Reading(value, nowUtc, staleAfterSeconds);

        // A negative on a forward metric cannot be drawn as flow, so the graph clamps it to zero. Say so
        // rather than let the operator read that as "nothing is happening here" — the fix is theirs to make
        // (bind the reverse direction as e.g. realpower#in), and they can only make it if they are told.
        if (value < 0 && !metric.EndsWith(FlowMetricKey.InSuffix, StringComparison.Ordinal))
            signed[(nodeId, metric)] = value;
        else
            signed.TryRemove((nodeId, metric), out _);
    }

    public IReadOnlyCollection<WithheldSource> Withheld =>
        signed.Select(kv => new WithheldSource(
            kv.Key.Node, kv.Key.Metric, kv.Key.Metric,
            $"Reported {kv.Value:0.##}, and a negative {kv.Key.Metric} cannot flow forwards — it is shown as 0. "
          + $"If this source signs the reverse direction, bind that direction as '{kv.Key.Metric}{FlowMetricKey.InSuffix}'."))
            .ToList();

    public void Remove(string nodeId, string metric) => latest.TryRemove((nodeId, metric), out _);

    /// <summary>The (node, metric) pairs currently held, fresh or not.</summary>
    public IReadOnlyCollection<(string Node, string Metric)> Keys => latest.Keys.ToList();

    public bool TryGetValue(string nodeId, string metric, out double value)
        => TryGetValue(nodeId, metric, DateTime.UtcNow, out value);

    /// <summary>Testable overload: resolve against an explicit "now".</summary>
    public bool TryGetValue(string nodeId, string metric, DateTime nowUtc, out double value)
    {
        value = 0;
        if (!latest.TryGetValue((nodeId, metric), out var r))
            return false;
        // A dead publisher must not keep propping up the flow (and the energy dashboard) with a value that
        // stopped being true hours ago — better to drop the node than to export a stale reading as current.
        if (r.StaleAfterSeconds > 0 && (nowUtc - r.AtUtc).TotalSeconds > r.StaleAfterSeconds)
            return false;
        value = r.Value;
        return true;
    }

    /// <inheritdoc />
    public IReadOnlyCollection<(string Node, string Metric)> ReportedKeys => Keys;

    /// <inheritdoc />
    public bool TryDescribe(string nodeId, string metric, out FlowReading reading)
        => TryDescribe(nodeId, metric, DateTime.UtcNow, out reading);

    /// <summary>Testable overload: resolve freshness against an explicit "now".</summary>
    public bool TryDescribe(string nodeId, string metric, DateTime nowUtc, out FlowReading reading)
    {
        reading = default;
        if (!latest.TryGetValue((nodeId, metric), out var r))
            return false;
        // Unlike TryGetValue, an expired reading is still returned — flagged, not hidden. Telling "nothing
        // ever reported this" apart from "it stopped an hour ago" is the whole point of this interface.
        var fresh = r.StaleAfterSeconds <= 0 || (nowUtc - r.AtUtc).TotalSeconds <= r.StaleAfterSeconds;
        reading = new FlowReading(r.Value, r.AtUtc, r.StaleAfterSeconds, fresh);
        return true;
    }
}
