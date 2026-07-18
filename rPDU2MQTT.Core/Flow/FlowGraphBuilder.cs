using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Models.PDU;

namespace rPDU2MQTT.Core.Flow;

/// <summary>
/// Builds a <see cref="FlowGraph"/> from a PDU snapshot, merged with the optional user-defined
/// hierarchy (<see cref="EnergyFlowConfig"/>, #129). The base flow is auto-derived PDU → outlet,
/// weighted by a per-outlet measurement (default <c>realpower</c>); custom upstream nodes/parents
/// (breakers, transfer switch, "Total") are layered on top, and every link value aggregates up from the
/// leaf (outlet) measurements.
/// </summary>
public static class FlowGraphBuilder
{
    public const string DefaultMetric = "realpower";

    public static FlowGraph Build(PduData data, string metric = DefaultMetric)
        => Build(data, null, metric);

    /// <param name="live">
    /// Optional supplier of live leaf values for custom nodes (MQTT/Solar Assistant today, #205). A live
    /// reading for the metric being built wins over the node's static <c>Value</c>.
    /// </param>
    public static FlowGraph Build(PduData data, EnergyFlowConfig? flow, string metric = DefaultMetric, IFlowValueSource? live = null)
    {
        flow ??= new EnergyFlowConfig();
        var label = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var kind = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var leaf = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);   // outlet id -> measured value
        var outgoing = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
        var units = "";

        void AddEdge(string from, string to)
        {
            if (!outgoing.TryGetValue(from, out var list)) outgoing[from] = list = new();
            list.Add(to);
        }

        // Following the edges already added, can `a` reach `b`?
        bool Reaches(string a, string b)
        {
            var stack = new Stack<string>();
            stack.Push(a);
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            while (stack.Count > 0)
            {
                var x = stack.Pop();
                if (!seen.Add(x)) continue;
                if (outgoing.TryGetValue(x, out var kids))
                    foreach (var k in kids)
                    {
                        if (string.Equals(k, b, StringComparison.OrdinalIgnoreCase)) return true;
                        stack.Push(k);
                    }
            }
            return false;
        }

        // Add an edge only if it keeps the graph acyclic. The editor blocks loops in the UI, but the
        // config can be hand-edited to bypass that; dropping any self-loop or cycle-closing link here
        // keeps the flow a DAG so aggregation terminates and the Sankey stays sane. Returns false if skipped.
        bool AddEdgeSafe(string from, string to)
        {
            if (string.Equals(from, to, StringComparison.OrdinalIgnoreCase)) return false;  // self-loop
            if (Reaches(to, from)) return false;                                            // would close a cycle
            AddEdge(from, to);
            return true;
        }

        // Nodes the user has explicitly wired a feeder for (via Links or legacy Parents) — their auto
        // PDU → outlet link is suppressed so the custom wiring takes over.
        var explicitlyFed = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var l in flow.Links) if (!string.IsNullOrEmpty(l.To)) explicitlyFed.Add(l.To);
        foreach (var child in flow.Parents.Keys) if (!string.IsNullOrEmpty(child)) explicitlyFed.Add(child);

        // Auto-derived base flow: each PDU feeds its outlets, weighted by the chosen measurement.
        foreach (var device in data.Devices)
        {
            var pduId = $"pdu:{device.Entity_Name}";
            foreach (var outlet in device.Outlets)
            {
                var m = outlet.Measurements.FirstOrDefault(x => string.Equals(x.Type, metric, StringComparison.OrdinalIgnoreCase));
                if (m is null || !double.TryParse(m.Value, System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out var value) || value <= 0)
                    continue;
                if (string.IsNullOrEmpty(units)) units = m.Units;

                var outletId = $"outlet:{device.Entity_Name}:{outlet.Key}";
                label[outletId] = outlet.Entity_DisplayName; kind[outletId] = "outlet"; leaf[outletId] = value;
                label[pduId] = device.Entity_DisplayName; kind[pduId] = "pdu";
                // Skip the auto PDU link when the user has wired an explicit feeder for this outlet.
                if (!explicitlyFed.Contains(outletId))
                    AddEdge(pduId, outletId);
            }
        }

        // Custom upstream nodes (#129). A node is a leaf source when it has a value of its own: a live
        // reading bound to this metric (MQTT/Solar Assistant, #205) if one has arrived, else the static
        // Value. Nodes that aggregate children have neither and are summed from below.
        foreach (var n in flow.Nodes)
            if (!string.IsNullOrEmpty(n.Id))
            {
                label[n.Id] = string.IsNullOrEmpty(n.Label) ? n.Id : n.Label;
                // The node's declared kind (battery, inverter, panel, …) styles the diagram; fall back to
                // the generic "node" when unset. Don't override an auto id that already resolved to pdu/outlet.
                if (!kind.ContainsKey(n.Id)) kind[n.Id] = string.IsNullOrWhiteSpace(n.Kind) ? "node" : n.Kind.Trim().ToLowerInvariant();
                if (live is not null && live.TryGetValue(n.Id, metric, out var liveValue))
                {
                    // A live reading is authoritative even at 0: solar at night generates nothing, and the
                    // static Value must not resurrect a phantom figure. (0 makes it a producer supplying 0,
                    // so its links drop out — as opposed to having no value at all, which would make it an
                    // aggregator that passes its children's demand upward.)
                    // A negative reading — a battery under the opposite sign convention — can't be expressed
                    // in a directed DAG and would subtract from the roll-up, so clamp it; use Scale: -1 on
                    // the source to flip the convention instead.
                    leaf[n.Id] = Math.Max(0, liveValue);
                }
                else if (n.Value is > 0) leaf[n.Id] = n.Value.Value;
            }

        // Custom directed links (From feeds To) plus legacy Parents (parent feeds child) — only when both
        // endpoints are known nodes. A node may gather several feeders (multi-parent) and a producer is
        // simply a link pointing into what it powers (e.g. solar → inverter).
        foreach (var l in flow.Links)
            if (!string.IsNullOrEmpty(l.From) && !string.IsNullOrEmpty(l.To) && label.ContainsKey(l.From) && label.ContainsKey(l.To))
                AddEdgeSafe(l.From, l.To);
        foreach (var (child, parent) in flow.Parents)
            if (!string.IsNullOrEmpty(child) && !string.IsNullOrEmpty(parent) && label.ContainsKey(child) && label.ContainsKey(parent))
                AddEdgeSafe(parent, child);

        // Which feeders point into each node — used to split a node's demand across them (so a node
        // reachable by several paths isn't counted multiple times) and, crucially, to let measured feeders
        // supply their real figure before the untracked remainder is shared out among the rest.
        var incoming = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
        foreach (var (from, kids) in outgoing)
            foreach (var to in kids)
            {
                if (!incoming.TryGetValue(to, out var fs)) incoming[to] = fs = new();
                fs.Add(from);
            }

        // Per-node value mode (#129): governs how an unmeasured node is valued. A node with a live/static
        // value ignores this. Unknown/blank -> "auto" (the historical behaviour).
        var mode = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var n in flow.Nodes)
            if (!string.IsNullOrEmpty(n.Id))
                mode[n.Id] = string.IsNullOrWhiteSpace(n.Mode) ? "auto" : n.Mode.Trim().ToLowerInvariant();
        string Mode(string id) => mode.TryGetValue(id, out var m) ? m : "auto";

        // Need(id): power this node must receive = its known value (outlet sink or producer), else the sum
        // of the flows on its outgoing links. Memoized + cycle-guarded.
        var needMemo = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);
        double Need(string id, HashSet<string> path)
        {
            if (needMemo.TryGetValue(id, out var cached)) return cached;
            if (!path.Add(id)) return 0;   // cycle guard
            double v = leaf.TryGetValue(id, out var lv)
                ? lv
                : (outgoing.TryGetValue(id, out var kids) ? kids.Sum(k => EdgeFlow(id, k, path)) : 0);
            path.Remove(id);
            needMemo[id] = v;
            return v;
        }
        // Demand a single child draws through one of its feeders (its downstream need, split if it has
        // several feeders) — used when a measured parent distributes its total across tracked children.
        double DemandShare(string child, HashSet<string> path)
            => Need(child, path) / Math.Max(1, incoming.TryGetValue(child, out var f) ? f.Count : 1);

        // EdgeFlow(from -> to): how much flows along one link.
        //  - A producer (a measured leaf feeding others) supplies its generation, divided across the things
        //    it powers in proportion to their downstream demand (equal split if none draw anything) — so a
        //    producer feeding several consumers isn't counted once per link. Except: if one of its children
        //    is marked 'untracked', the tracked children draw their real demand and the untracked child mops
        //    up the parent's remaining measured throughput (HA-style untracked consumption) — so the parent's
        //    total is conserved rather than scaled to fill the tracked children.
        //  - An unmeasured feeder conveys part of the target's *remaining* demand: measured siblings supply
        //    their real figure first, and only what's left over (the untracked portion) is shared out. That
        //    stops the graph fabricating a value for, say, Grid when Solar already covers the load. Which
        //    unmeasured feeders share the remainder is set by their Mode: an explicit 'residual' node is the
        //    designated absorber, 'none' takes nothing, and plain 'auto' feeders split it when no 'residual'
        //    node is present.
        double EdgeFlow(string from, string to, HashSet<string> path)
        {
            if (leaf.TryGetValue(from, out var produced))
            {
                var kids = outgoing.TryGetValue(from, out var k) ? k : new List<string>();

                // Untracked children only make sense under a parent with a known total (this measured leaf).
                var untracked = kids.Where(c => Mode(c) == "untracked").ToList();
                if (untracked.Count > 0)
                {
                    var trackedDraw = kids.Where(c => Mode(c) != "untracked").Sum(c => DemandShare(c, path));
                    var spare = Math.Max(0, produced - trackedDraw);
                    return Mode(to) == "untracked" ? spare / untracked.Count : DemandShare(to, path);
                }

                if (kids.Count <= 1) return produced;
                var totalDemand = kids.Sum(c => Need(c, path));
                return totalDemand > 0 ? produced * Need(to, path) / totalDemand : produced / kids.Count;
            }

            // A 'none' node never infers a value, and a 'static' node with no value here (a valued one is
            // already a leaf above) has nothing to give — both contribute zero rather than absorbing demand.
            static bool Inert(string m) => m is "none" or "static";
            if (Inert(Mode(from))) return 0;

            var feeders = incoming.TryGetValue(to, out var fs) ? fs : new List<string>();
            var measured = feeders.Where(leaf.ContainsKey).Sum(f => EdgeFlow(f, to, path));
            var remainder = Math.Max(0, Need(to, path) - measured);

            // Unmeasured feeders that may absorb the remainder. If any is 'residual', only those share it;
            // otherwise the 'auto' feeders split it (back-compat when nothing is measured).
            var unmeasured = feeders.Where(f => !leaf.ContainsKey(f) && !Inert(Mode(f))).ToList();
            var residual = unmeasured.Where(f => Mode(f) == "residual").ToList();
            var absorbers = residual.Count > 0 ? residual : unmeasured;
            if (absorbers.Count == 0 || !absorbers.Contains(from, StringComparer.OrdinalIgnoreCase)) return 0;
            return remainder / absorbers.Count;
        }

        // Emit one link per edge, valued by the flow it carries.
        var links = new List<FlowLink>();
        var used = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var (from, kids) in outgoing)
            foreach (var to in kids)
            {
                var value = EdgeFlow(from, to, new HashSet<string>(StringComparer.OrdinalIgnoreCase));
                if (value <= 0) continue;
                links.Add(new FlowLink(from, to, value));
                used.Add(from); used.Add(to);
            }

        var nodes = used
            .Select(id => new FlowNode(id, label.TryGetValue(id, out var l) ? l : id, kind.TryGetValue(id, out var k) ? k : "node"))
            .ToList();

        return new FlowGraph(nodes, links, metric, units);
    }
}
