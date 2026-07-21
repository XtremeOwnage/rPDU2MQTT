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

        static string TypeOf(EnergyFlowNode n)
            => n.AllSources().Any() || n.Value.HasValue ? "measured"
             : string.Equals(n.Mode, "residual", StringComparison.OrdinalIgnoreCase) ? "residual"
             : "aggregate";
        string TypeOfId(string id) => byId.TryGetValue(id, out var n) ? TypeOf(n) : "measured";  // unknown ref = a leaf

        // Feeders: for each target, the nodes wired to feed it (Links + legacy Parents both mean From feeds To).
        var feeders = new Dictionary<string, List<string>>(cmp);
        void Feed(string? from, string? to)
        {
            if (string.IsNullOrWhiteSpace(from) || string.IsNullOrWhiteSpace(to)) return;
            if (!feeders.TryGetValue(to.Trim(), out var list)) feeders[to.Trim()] = list = new();
            list.Add(from.Trim());
        }
        foreach (var l in flow.Links) Feed(l.From, l.To);
        foreach (var (child, parent) in flow.Parents) Feed(parent, child);   // parent feeds child

        var plans = new List<NodePlan>();
        foreach (var n in byId.Values)
        {
            var id = n.Id.Trim();
            var children = feeders.TryGetValue(id, out var fs)
                ? fs.Distinct(cmp).Select(f => new NodeChild(TypeOfId(f), f)).ToList()
                : new List<NodeChild>();
            var mode = string.IsNullOrWhiteSpace(n.Mode) ? "auto" : n.Mode.Trim().ToLowerInvariant();
            plans.Add(new NodePlan(id, TypeOf(n), new NodeSpec(mode, children), n.Value));
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
