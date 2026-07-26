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
}
