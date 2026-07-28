namespace rPDU2MQTT.Core.Flow;

/// <summary>
/// The cache/metric key a flow reading is stored under, given its <see cref="Models.Config.EnergyFlowSource.Direction"/>.
/// <para>
/// A node's <c>out</c> reading (discharge/import/production) is the supply value the whole flow roll-up reads
/// for <c>(node, metric)</c>, so it keeps the bare metric. An <c>in</c> reading (battery charge, grid export)
/// is a distinct quantity that must not overwrite it, so it is stored under a suffixed key — invisible to the
/// main graph, retrievable by the exporter that publishes the battery-charge / grid-export sensors (#energy-rollup).
/// </para>
/// </summary>
public static class FlowMetricKey
{
    /// <summary>Suffix marking an in-direction reading. Chosen so it can't collide with a real metric name.</summary>
    public const string InSuffix = "#in";

    /// <summary>The storage key for <paramref name="metric"/> in the given direction ("in" / "out").</summary>
    public static string For(string metric, string? direction)
        => string.Equals(direction, "in", System.StringComparison.OrdinalIgnoreCase) ? metric + InSuffix : metric;

    /// <summary>The storage key for <paramref name="metric"/> in the given <see cref="EnergyDirection"/>.</summary>
    public static string For(string metric, EnergyDirection direction)
        => direction == EnergyDirection.In ? metric + InSuffix : metric;

    /// <summary>True for the <c>split</c> direction — one signed source fanned into both out and in.</summary>
    public static bool IsSplit(string? direction) => string.Equals(direction, "split", System.StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// The cache key(s) and value(s) a reading produces. Normally one — the metric under its direction. But a
    /// <c>split</c> source carries a single signed number (a battery/grid power that swings ±) and fans into
    /// both directions: the positive part is the out (discharge/import) reading, the magnitude of the negative
    /// part is the in (charge/export) reading. So one topic/register drives both without needing two feeds.
    /// </summary>
    public static IEnumerable<(string Key, double Value)> Fan(string metric, string? direction, double value)
        => IsSplit(direction)
            ? new[] { (metric, System.Math.Max(0, value)), (metric + InSuffix, System.Math.Max(0, -value)) }
            : new[] { (For(metric, direction), value) };

    /// <summary>The cache key(s) a source writes, without values — for staleness/binding bookkeeping.</summary>
    public static IEnumerable<string> Keys(string metric, string? direction)
        => IsSplit(direction) ? new[] { metric, metric + InSuffix } : new[] { For(metric, direction) };
}
