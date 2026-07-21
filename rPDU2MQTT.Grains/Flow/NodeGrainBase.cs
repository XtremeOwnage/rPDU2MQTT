using Orleans.Concurrency;
using rPDU2MQTT.Abstractions.Flow;
using rPDU2MQTT.Grains.Abstractions.Flow;

namespace rPDU2MQTT.Grains.Flow;

/// <summary>
/// Shared base for every energy-flow node grain — the whole dataflow machinery lives here, so a concrete node
/// type is nothing but a <see cref="Compute"/> rule.
/// <para>
/// The base owns: the subscriptions to this node's upstreams (the nodes it depends on), the cache of what
/// those upstreams last pushed, the recompute-on-change, and the publish to this node's own subscribers plus
/// the <see cref="IFlowGrain"/> projection. Values move <b>up</b> the graph as pushes — a measured leaf that
/// moves notifies its parent, which recomputes and notifies its parent, and so on to the root. Publishing is
/// change-gated (an unchanged value is not propagated), which both keeps the traffic proportional to what
/// actually moved and stops a mis-configured cycle from looping forever.
/// </para>
/// <para>
/// Grains are <see cref="ReentrantAttribute">reentrant</see> because the pushes are inherently re-entrant: a
/// node calls <c>Subscribe</c> on an upstream, which calls straight back into it with the current values.
/// </para>
/// </summary>
[Reentrant]
public abstract class NodeGrainBase : Grain, INodeGrain
{
    private static readonly Metric[] AllMetrics = Enum.GetValues<Metric>();

    /// <summary>Re-subscribe + re-publish cadence: heals a link whose other end was reactivated meanwhile.</summary>
    private static readonly TimeSpan Heartbeat = TimeSpan.FromSeconds(30);

    protected NodeSpec spec = new("aggregate", new());

    /// <summary>What each upstream node last pushed us, per metric — the inputs <see cref="Compute"/> reads.</summary>
    private readonly Dictionary<string, Dictionary<Metric, double>> inputs = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>The nodes that depend on us and want our changes pushed to them.</summary>
    private readonly Dictionary<string, NodeChild> subscribers = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Our own current value per metric — what we last published.</summary>
    private readonly Dictionary<Metric, double> published = new();

    private IGrainTimer? heartbeat;

    /// <summary>Which grain type owns this node — what we hand upstreams so they can call us back.</summary>
    protected abstract string NodeType { get; }

    /// <summary>This node's value for a metric from its cached inputs. Pure: no awaits, no grain calls.</summary>
    protected abstract double? Compute(Metric metric);

    protected string Id => this.GetPrimaryKeyString();

    private NodeChild Self => new(NodeType, Id);

    private IFlowGrain Flow => GrainFactory.GetGrain<IFlowGrain>(0);

    public override Task OnActivateAsync(CancellationToken cancellationToken)
    {
        // KeepAlive: a node that stops being read still has to keep its links live and its value visible.
        heartbeat = this.RegisterGrainTimer(HeartbeatAsync, new GrainTimerCreationOptions(Heartbeat, Heartbeat) { KeepAlive = true });
        return base.OnActivateAsync(cancellationToken);
    }

    public override Task OnDeactivateAsync(DeactivationReason reason, CancellationToken cancellationToken)
    {
        heartbeat?.Dispose();
        return base.OnDeactivateAsync(reason, cancellationToken);
    }

    public virtual async Task Configure(NodeSpec next)
    {
        var wanted = Upstreams(next);
        var current = Upstreams(spec);
        spec = next;

        foreach (var gone in current.Where(u => !wanted.ContainsKey(u.Key)).ToList())
        {
            inputs.Remove(gone.Key);
            await Ref(gone.Value).Unsubscribe(Id);
        }
        // Subscribing replays the upstream's current values back into us, so a node wired up long after its
        // sources started reporting is immediately correct — no waiting for the next change.
        foreach (var added in wanted.Where(u => !current.ContainsKey(u.Key)).ToList())
            await Ref(added.Value).Subscribe(Self);

        await RecomputeAll();
    }

    public async Task Subscribe(NodeChild subscriber)
    {
        subscribers[subscriber.Id] = subscriber;
        var target = Ref(subscriber);
        foreach (var (metric, value) in published.ToList())
            await target.OnInputChanged(Id, metric, value);
    }

    public Task Unsubscribe(string subscriberId)
    {
        subscribers.Remove(subscriberId);
        return Task.CompletedTask;
    }

    public async Task OnInputChanged(string nodeId, Metric metric, double? value)
    {
        if (!inputs.TryGetValue(nodeId, out var byMetric))
            inputs[nodeId] = byMetric = new();

        if (value is { } v) byMetric[metric] = v;
        else byMetric.Remove(metric);

        await Recompute(metric);
    }

    public Task<double?> Value(Metric metric)
        => Task.FromResult(published.TryGetValue(metric, out var v) ? v : (double?)null);

    public Task<NodeDescription> Describe()
        => Task.FromResult(new NodeDescription(Id, spec.Mode, spec.Children.Count));

    /// <summary>What an upstream last reported for a metric, or null if it has no value for it.</summary>
    protected double? Input(string nodeId, Metric metric)
        => inputs.TryGetValue(nodeId, out var byMetric) && byMetric.TryGetValue(metric, out var v) ? v : null;

    /// <summary>Recompute one metric and, if the answer moved, push it to our subscribers and the flow grain.</summary>
    protected async Task Recompute(Metric metric)
    {
        var next = Compute(metric);
        var now = published.TryGetValue(metric, out var p) ? p : (double?)null;
        if (Same(next, now)) return;

        if (next is { } v) published[metric] = v;
        else published.Remove(metric);

        foreach (var s in subscribers.Values.ToList())
            await Ref(s).OnInputChanged(Id, metric, next);

        await Flow.PublishNodeValue(Id, metric, next);
    }

    protected async Task RecomputeAll()
    {
        foreach (var metric in AllMetrics)
            await Recompute(metric);
    }

    /// <summary>The nodes this one depends on: its children, plus (for a residual) the parent it splits.</summary>
    private static Dictionary<string, NodeChild> Upstreams(NodeSpec s)
    {
        var map = new Dictionary<string, NodeChild>(StringComparer.OrdinalIgnoreCase);
        foreach (var c in s.Children) map[c.Id] = c;
        if (s.Parent is { } p) map[p.Id] = p;
        return map;
    }

    /// <summary>Resolve a node reference to its grain, picked by the reference's declared type.</summary>
    private INodeGrain Ref(NodeChild c) => c.Type.Trim().ToLowerInvariant() switch
    {
        "measured" => GrainFactory.GetGrain<IMeasuredNodeGrain>(c.Id),
        "residual" => GrainFactory.GetGrain<IResidualNodeGrain>(c.Id),
        _ => GrainFactory.GetGrain<IAggregateNodeGrain>(c.Id),
    };

    /// <summary>Re-assert both ends of every link, so reactivation on either side can't leave us stranded.</summary>
    private async Task HeartbeatAsync(CancellationToken ct)
    {
        foreach (var u in Upstreams(spec).Values.ToList())
            await Ref(u).Subscribe(Self);

        foreach (var (metric, value) in published.ToList())
            await Flow.PublishNodeValue(Id, metric, value);
    }

    private static bool Same(double? a, double? b)
        => a is null ? b is null : b is not null && Math.Abs(a.Value - b.Value) < 1e-9;
}
