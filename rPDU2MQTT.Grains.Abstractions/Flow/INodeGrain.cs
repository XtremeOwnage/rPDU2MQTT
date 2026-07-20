using rPDU2MQTT.Abstractions.Flow;

namespace rPDU2MQTT.Grains.Abstractions.Flow;

/// <summary>
/// The base energy-flow node actor (key = node id). Every node type — aggregate (Σ children), measured leaf,
/// residual — implements this, so a parent rolls up its children uniformly through <see cref="Value"/>
/// regardless of their type. Designed for scale: a densely-measured tree (per-panel → string → MPPT →
/// sub-panel → total, CT-clamped breakers, outlets) rolls up as distributed grain-to-grain sums, each node
/// owning its own state and children.
/// </summary>
public interface INodeGrain : IGrainWithStringKey
{
    /// <summary>Set this node's mode + children (pushed by the flow reconciler from config).</summary>
    Task Configure(NodeSpec spec);

    /// <summary>This node's value for a metric — its own measurement (leaf) or the roll-up of its children.</summary>
    Task<double?> Value(Metric metric);

    /// <summary>Self-description for the grain tree.</summary>
    Task<NodeDescription> Describe();
}

/// <summary>A node whose value is the sum of its children (strings, MPPTs, panels, sub-panels, "Total").</summary>
public interface IAggregateNodeGrain : INodeGrain { }

/// <summary>A measured leaf — value comes from a source (Tigo/Modbus panel, CT clamp, outlet, MQTT).</summary>
public interface IMeasuredNodeGrain : INodeGrain
{
    /// <summary>Record this leaf's latest measured value for a metric (pushed by the source fan-out).</summary>
    Task Observe(Metric metric, double value);
}

/// <summary>A node that absorbs the remainder of a measured parent not accounted for by its measured siblings.</summary>
public interface IResidualNodeGrain : INodeGrain { }
