using System.Collections.Concurrent;

namespace rPDU2MQTT.Core.Flow;

/// <summary>Newest reported value per (node, metric), expiring when the publisher goes quiet.</summary>
public sealed class FlowValueCache : IFlowValueSource, IFlowValueDiagnostics, IWithheldSources
{
    private sealed record Reading(double Value, DateTime AtUtc, int StaleAfterSeconds);

    private readonly ConcurrentDictionary<(string Node, string Metric), Reading> latest = new();

    private readonly ConcurrentDictionary<(string Node, string Metric), ConcurrentDictionary<string, Reading>> parts = new();

    private readonly ConcurrentDictionary<(string Node, string Metric), double> signed = new();

    /// <summary>Record a reading. A stale-after of 0 never expires.</summary>
    public void Set(string nodeId, string metric, double value, int staleAfterSeconds, DateTime nowUtc)
    {
        latest[(nodeId, metric)] = new Reading(value, nowUtc, staleAfterSeconds);

        if (value < 0 && !metric.EndsWith(FlowMetricKey.InSuffix, StringComparison.Ordinal))
            signed[(nodeId, metric)] = value;
        else
            signed.TryRemove((nodeId, metric), out _);
    }

    /// <summary>Record one of several sources on a (node, metric) and store their sum once all are fresh.</summary>
    public bool SetPart(string nodeId, string metric, string part, IReadOnlyCollection<string> expectedParts,
                        double value, int staleAfterSeconds, DateTime nowUtc, out double sum)
    {
        sum = value;
        if (expectedParts.Count <= 1)
        {
            Set(nodeId, metric, value, staleAfterSeconds, nowUtc);
            return true;
        }

        var held = parts.GetOrAdd((nodeId, metric), _ => new(StringComparer.Ordinal));
        held[part] = new Reading(value, nowUtc, staleAfterSeconds);

        sum = 0;
        var stale = 0;
        foreach (var p in expectedParts)
        {
            if (!held.TryGetValue(p, out var r)) return false;
            if (r.StaleAfterSeconds > 0 && (nowUtc - r.AtUtc).TotalSeconds > r.StaleAfterSeconds) return false;
            if (r.StaleAfterSeconds > 0 && (stale == 0 || r.StaleAfterSeconds < stale)) stale = r.StaleAfterSeconds;
            sum += r.Value;
        }
        Set(nodeId, metric, sum, stale, nowUtc);
        return true;
    }

    public IReadOnlyCollection<WithheldSource> Withheld =>
        signed.Select(kv => new WithheldSource(
            kv.Key.Node, kv.Key.Metric, kv.Key.Metric,
            $"Reported {kv.Value:0.##}, and a negative {kv.Key.Metric} cannot flow forwards — it is shown as 0. "
          + $"If this source signs the reverse direction, bind that direction as '{kv.Key.Metric}{FlowMetricKey.InSuffix}'."))
            .ToList();

    public void Remove(string nodeId, string metric)
    {
        latest.TryRemove((nodeId, metric), out _);
        parts.TryRemove((nodeId, metric), out _);
    }

    /// <summary>The (node, metric) pairs currently held, fresh or not.</summary>
    public IReadOnlyCollection<(string Node, string Metric)> Keys => latest.Keys.ToList();

    public bool TryGetValue(string nodeId, string metric, out double value)
        => TryGetValue(nodeId, metric, DateTime.UtcNow, out value);

    /// <summary>Testable overload.</summary>
    public bool TryGetValue(string nodeId, string metric, DateTime nowUtc, out double value)
    {
        value = 0;
        if (!latest.TryGetValue((nodeId, metric), out var r))
            return false;
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

    /// <summary>Testable overload.</summary>
    public bool TryDescribe(string nodeId, string metric, DateTime nowUtc, out FlowReading reading)
    {
        reading = default;
        if (!latest.TryGetValue((nodeId, metric), out var r))
            return false;
        var fresh = r.StaleAfterSeconds <= 0 || (nowUtc - r.AtUtc).TotalSeconds <= r.StaleAfterSeconds;
        reading = new FlowReading(r.Value, r.AtUtc, r.StaleAfterSeconds, fresh);
        return true;
    }
}
