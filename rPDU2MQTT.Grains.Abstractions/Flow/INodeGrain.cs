using rPDU2MQTT.Abstractions.Flow;

namespace rPDU2MQTT.Grains.Abstractions.Flow;

/// <summary>
/// The base energy-flow node actor (key = node id). Every node type — aggregate (Σ children), measured leaf,
/// residual — implements this, so a node depends on its upstreams uniformly regardless of their type.
/// <para>
/// Nodes are wired as a <b>push</b> dataflow, not a pull tree: a node <see cref="Subscribe"/>s to the nodes it
/// depends on, each of those pushes <see cref="OnInputChanged"/> whenever its own value moves, and the node
/// recomputes and publishes its value to <i>its</i> subscribers. Nothing walks the tree at read time —
/// <see cref="Value"/> is the last computed value, already in hand. That's what makes a densely-measured tree
/// (per-panel → string → MPPT → sub-panel → total, CT-clamped breakers, outlets) scale: a change touches only
/// the path from the node that moved up to the root, and each node owns its own state, children and math.
/// </para>
/// </summary>
public interface INodeGrain : IGrainWithStringKey
{
    /// <summary>
    /// Set this node's mode + upstreams (pushed by the flow reconciler from config). The node subscribes to
    /// any new upstream and drops subscriptions it no longer needs, then recomputes.
    /// </summary>
    Task Configure(NodeSpec spec);

    /// <summary>This node's current value for a metric — computed on the last change, not on this call.</summary>
    Task<double?> Value(Metric metric);

    /// <summary>
    /// Start pushing this node's value changes to <paramref name="subscriber"/>. Idempotent, and it replays
    /// the current values immediately so a fresh (or reactivated) subscriber starts from live state.
    /// </summary>
    Task Subscribe(NodeChild subscriber);

    /// <summary>Stop pushing to that subscriber (its topology changed and it no longer depends on us).</summary>
    Task Unsubscribe(string subscriberId);

    /// <summary>
    /// An upstream node this one subscribed to has a new value for a metric (null = it no longer has one).
    /// The node caches it, recomputes its own value, and publishes onward if that value changed.
    /// </summary>
    Task OnInputChanged(string nodeId, Metric metric, double? value);

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
