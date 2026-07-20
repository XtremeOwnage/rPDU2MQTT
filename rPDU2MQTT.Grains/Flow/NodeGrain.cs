using rPDU2MQTT.Abstractions.Flow;
using rPDU2MQTT.Grains.Abstractions.Flow;

namespace rPDU2MQTT.Grains.Flow;

/// <summary>
/// A single energy-flow node (key = node id). Holds this node's latest leaf values with their staleness, so
/// the node is directly queryable and shows up as its own activation in the grain tree. Deactivates when idle
/// — like any grain, it's cheap to bring back when its node is fed again.
/// </summary>
public sealed class NodeGrain : Grain, INodeGrain
{
    private readonly Dictionary<Metric, (double Value, int StaleAfterSeconds, DateTime Ts)> values = new();

    public Task Set(List<MeasurementReading> readings)
    {
        var now = DateTime.UtcNow;
        foreach (var r in readings) values[r.Metric] = (r.Value, r.StaleAfterSeconds, now);
        return Task.CompletedTask;
    }

    public Task<List<MeasurementReading>> Values()
    {
        var now = DateTime.UtcNow;
        var nodeId = this.GetPrimaryKeyString();
        var live = values
            .Where(kv => (now - kv.Value.Ts).TotalSeconds <= kv.Value.StaleAfterSeconds)
            .Select(kv => new MeasurementReading(nodeId, kv.Key, kv.Value.Value, kv.Value.StaleAfterSeconds))
            .ToList();
        return Task.FromResult(live);
    }
}
