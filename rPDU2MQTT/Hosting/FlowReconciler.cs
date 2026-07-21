using Microsoft.Extensions.Hosting;
using Orleans;
using rPDU2MQTT.Abstractions.Flow;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Grains.Abstractions.Flow;
using rPDU2MQTT.Models.Config;

namespace rPDU2MQTT.Hosting;

/// <summary>
/// Provisions the polymorphic node-grain tree from the energy-flow config (v3). On a timer it reads the
/// config, decides each node's type (measured leaf / aggregate / residual) and its children, and pushes a
/// <see cref="NodeSpec"/> to the right grain — so the parent grains manage exactly the children the config
/// declares. Feeder aggregation: a node's children are the nodes wired to feed it (a Link From → To makes
/// From a child of To), so a measured leaf wired into an aggregate rolls up (panel → string → MPPT).
/// </summary>
public sealed class FlowReconciler : BackgroundService
{
    private readonly IGrainFactory grains;
    private readonly Config config;

    public FlowReconciler(IGrainFactory grains, Config config)
    {
        this.grains = grains;
        this.config = config;
    }

    /// <summary>A node's provisioning plan: which grain type owns it and the spec to push.</summary>
    public sealed record NodePlan(string Id, string Type, NodeSpec Spec, double? StaticValue);

    /// <summary>
    /// Turn the energy-flow config into a per-node plan. Pure + testable. A node is a <c>measured</c> leaf
    /// when it has a live source or a static value, <c>residual</c> when its mode says so, else an
    /// <c>aggregate</c>. Children are its feeders (the From of every Link/legacy-Parent pointing at it).
    /// </summary>
    public static List<NodePlan> Plan(EnergyFlowConfig flow)
    {
        var cmp = StringComparer.OrdinalIgnoreCase;
        var byId = flow.Nodes
            .Where(n => !string.IsNullOrWhiteSpace(n.Id))
            .GroupBy(n => n.Id.Trim(), cmp)
            .ToDictionary(g => g.Key, g => g.First(), cmp);

        static string TypeOf(EnergyFlowNode n) => Core.Flow.FlowNodeClassifier.TypeOf(n);
        // Config nodes classify from their config; the auto PDU→outlet nodes the PduGrain provisions have a
        // known shape (pdu: aggregates, outlet: measured); any other unknown ref is treated as a leaf.
        string TypeOfId(string id)
            => byId.TryGetValue(id, out var n) ? TypeOf(n)
             : id.StartsWith("pdu:", StringComparison.OrdinalIgnoreCase) ? "aggregate"
             : "measured";

        // Feeders: for each target, the nodes wired to feed it. Feeds: for each source, what it feeds into.
        // (Links + legacy Parents both mean From feeds To.)
        var feeders = new Dictionary<string, List<string>>(cmp);
        var feeds = new Dictionary<string, List<string>>(cmp);
        void Feed(string? from, string? to)
        {
            if (string.IsNullOrWhiteSpace(from) || string.IsNullOrWhiteSpace(to)) return;
            from = from.Trim(); to = to.Trim();
            if (!feeders.TryGetValue(to, out var f)) feeders[to] = f = new(); f.Add(from);
            if (!feeds.TryGetValue(from, out var t)) feeds[from] = t = new(); t.Add(to);
        }
        foreach (var l in flow.Links) Feed(l.From, l.To);
        foreach (var (child, parent) in flow.Parents) Feed(parent, child);   // parent feeds child

        NodeChild Ref(string id) => new(TypeOfId(id), id);

        var plans = new List<NodePlan>();
        foreach (var n in byId.Values)
        {
            var id = n.Id.Trim();
            var type = TypeOf(n);
            var mode = string.IsNullOrWhiteSpace(n.Mode) ? "auto" : n.Mode.Trim().ToLowerInvariant();

            NodeSpec spec;
            if (type == "residual")
            {
                // A residual splits the total of the node it feeds: parent = what it feeds, siblings = that
                // parent's other measured feeders (the tracked portion it subtracts).
                var parentId = feeds.TryGetValue(id, out var ts) ? ts.FirstOrDefault() : null;
                var siblings = parentId is not null && feeders.TryGetValue(parentId, out var pf)
                    ? pf.Where(f => !cmp.Equals(f, id) && TypeOfId(f) == "measured").Distinct(cmp).Select(Ref).ToList()
                    : new List<NodeChild>();
                spec = new NodeSpec(mode, siblings, parentId is null ? null : Ref(parentId));
            }
            else
            {
                var children = feeders.TryGetValue(id, out var fs)
                    ? fs.Distinct(cmp).Select(Ref).ToList()
                    : new List<NodeChild>();
                spec = new NodeSpec(mode, children);
            }
            plans.Add(new NodePlan(id, type, spec, n.Value));
        }
        return plans;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try { await Task.Delay(TimeSpan.FromSeconds(4), stoppingToken); } catch (OperationCanceledException) { return; }

        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(15));
        do
        {
            try { await ReconcileAsync(); }
            catch (Exception ex) { Serilog.Log.Debug($"Flow reconciler: {ex.Message}"); }
        }
        while (await SafeWait(timer, stoppingToken));
    }

    private async Task ReconcileAsync()
    {
        foreach (var p in Plan(config.EnergyFlow))
        {
            INodeGrain grain = p.Type switch
            {
                "measured" => grains.GetGrain<IMeasuredNodeGrain>(p.Id),
                "residual" => grains.GetGrain<IResidualNodeGrain>(p.Id),
                _ => grains.GetGrain<IAggregateNodeGrain>(p.Id),
            };
            await grain.Configure(p.Spec);

            // A measured node with only a static value (no live source) is seeded here so it has a figure
            // until/unless a source overrides it via the ingest fan-out.
            if (p.Type == "measured" && p.StaticValue is { } v && grain is IMeasuredNodeGrain leaf)
                await leaf.Observe(Metric.RealPower, v);
        }
    }

    private static async Task<bool> SafeWait(PeriodicTimer timer, CancellationToken ct)
    {
        try { return await timer.WaitForNextTickAsync(ct); }
        catch (OperationCanceledException) { return false; }
    }
}
