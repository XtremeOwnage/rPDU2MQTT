using rPDU2MQTT.Abstractions.Flow;
using rPDU2MQTT.Grains.Abstractions.Flow;

namespace rPDU2MQTT.Grains.Flow;

/// <summary>
/// Shared base for every energy-flow node grain: holds the node's spec (mode + children) and the child
/// management every parent needs — resolving each child to its grain by declared type and summing them. The
/// concrete grain (aggregate / measured / residual) supplies only its own <see cref="Value"/> rule.
/// </summary>
public abstract class NodeGrainBase : Grain, INodeGrain
{
    protected NodeSpec spec = new("aggregate", new());

    public virtual Task Configure(NodeSpec s) { spec = s; return Task.CompletedTask; }

    public abstract Task<double?> Value(Metric metric);

    public Task<NodeDescription> Describe()
        => Task.FromResult(new NodeDescription(this.GetPrimaryKeyString(), spec.Mode, spec.Children.Count));

    /// <summary>Resolve a child reference to its grain via the shared base, picked by the child's declared type.</summary>
    protected INodeGrain Child(NodeChild c) => c.Type.Trim().ToLowerInvariant() switch
    {
        "measured" => GrainFactory.GetGrain<IMeasuredNodeGrain>(c.Id),
        "residual" => GrainFactory.GetGrain<IResidualNodeGrain>(c.Id),
        _ => GrainFactory.GetGrain<IAggregateNodeGrain>(c.Id),
    };

    /// <summary>Sum this node's children for a metric — the distributed roll-up (each child computes its own).</summary>
    protected async Task<double> SumChildren(Metric metric)
    {
        double sum = 0;
        foreach (var c in spec.Children)
        {
            var v = await Child(c).Value(metric);
            if (v.HasValue) sum += v.Value;
        }
        return sum;
    }
}
