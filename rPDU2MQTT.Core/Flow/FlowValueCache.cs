using System.Collections.Concurrent;

namespace rPDU2MQTT.Core.Flow;

/// <summary>
/// Holds the newest externally-reported value per (node, metric) and expires it once the publisher goes
/// quiet (#205). Kept free of any transport so the staleness rules are testable on their own; the MQTT
/// ingest (<c>EnergyFlowMqttSourceService</c>) is just one writer, and a future CT-clamp or inverter
/// poller can share it.
/// </summary>
public sealed class FlowValueCache : IFlowValueSource
{
    private sealed record Reading(double Value, DateTime AtUtc, int StaleAfterSeconds);

    // Written from broker callbacks, read by the exporters/GUI — hence concurrent.
    private readonly ConcurrentDictionary<(string Node, string Metric), Reading> latest = new();

    /// <summary>Record a reading. <paramref name="staleAfterSeconds"/> of 0 means it never expires.</summary>
    public void Set(string nodeId, string metric, double value, int staleAfterSeconds, DateTime nowUtc)
        => latest[(nodeId, metric)] = new Reading(value, nowUtc, staleAfterSeconds);

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
}
