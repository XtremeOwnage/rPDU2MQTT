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

        // A 'none' node never infers a value, and a 'static' node with no value here (a valued one is
        // already a leaf above) has nothing to give — both contribute zero rather than absorbing demand.
        static bool Inert(string m) => m is "none" or "static";

        // Which unmeasured feeders may supply what a node still needs after its measured feeders have
        // supplied their real figures. This is the line between inference and invention:
        //
        //  - An explicit 'residual' feeder was designated for exactly this, so it absorbs the remainder.
        //  - Otherwise a SINGLE unmeasured feeder conveys it. That isn't a guess: the load downstream is
        //    really being drawn, and the topology leaves it exactly one path to arrive by.
        //  - Several unmeasured feeders is a genuine unknown. Nothing says whether the load came from the
        //    solar, the battery or the grid, so NONE of them carry anything. Dividing it between them —
        //    which is what this used to do — states a number the user never supplied, on the diagram whose
        //    whole purpose is to be accurate. Mark one 'residual' to say where the remainder actually goes.
        List<string> Absorbers(string to)
        {
            var feeders = incoming.TryGetValue(to, out var fs) ? fs : new List<string>();
            var unmeasured = feeders.Where(f => !leaf.ContainsKey(f) && !Inert(Mode(f))).ToList();
            var residual = unmeasured.Where(f => Mode(f) == "residual").ToList();
            if (residual.Count > 0) return residual;
            return unmeasured.Count == 1 ? unmeasured : new List<string>();
        }

        // Is the flow along this link determined by measurements at all? False when several unmeasured
        // feeders compete to supply the same node — the link exists, but its share is unknowable, and it
        // must be shown as "no data" rather than as zero flow.
        bool Knowable(string from, string to)
        {
            if (leaf.ContainsKey(from)) return true;         // a measured producer supplies a real figure
            if (Inert(Mode(from))) return true;              // 'none'/'static': deliberately contributes nothing

            var feeders = incoming.TryGetValue(to, out var fs) ? fs : new List<string>();
            var unmeasured = feeders.Where(f => !leaf.ContainsKey(f) && !Inert(Mode(f))).ToList();

            // A designated residual is told what it carries, so its own flow is determined. Its unmeasured
            // siblings are not: "the residual takes the remainder" says nothing about how much solar was
            // generating, so reporting 0 W for them would be a claim we can't support either.
            if (unmeasured.Any(f => Mode(f) == "residual")) return Mode(from) == "residual";

            // One unmeasured path is determined by conservation. Several is a real unknown.
            return unmeasured.Count <= 1;
        }

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

            if (Inert(Mode(from))) return 0;

            var absorbers = Absorbers(to);
            if (!absorbers.Contains(from, StringComparer.OrdinalIgnoreCase)) return 0;

            var feeders = incoming.TryGetValue(to, out var fs) ? fs : new List<string>();
            var measured = feeders.Where(leaf.ContainsKey).Sum(f => EdgeFlow(f, to, path));
            var remainder = Math.Max(0, Need(to, path) - measured);
            return remainder / absorbers.Count;
        }

        // Emit one link per edge, valued by the flow it carries. A link whose flow is *unknowable* is still
        // emitted — carrying 0 and flagged — because the wiring is real even when the number isn't, and
        // silently dropping it hides a node the user deliberately configured.
        var links = new List<FlowLink>();
        // Every node the topology wires up, whether or not its link survives the filter below. Deriving the
        // node set from the surviving links is what made a configured node disappear.
        var wired = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var (from, kids) in outgoing)
            foreach (var to in kids)
            {
                wired.Add(from); wired.Add(to);

                var known = Knowable(from, to);
                var value = known ? EdgeFlow(from, to, new HashSet<string>(StringComparer.OrdinalIgnoreCase)) : 0;

                // A known-but-zero link carries nothing and is left off the diagram, as before. An *unknown*
                // link is kept — it draws as "no data" rather than implying zero flow.
                if (known && value <= 0) continue;

                links.Add(new FlowLink(from, to, value, known));
            }

        // A node's own value: its measurement if it has one, else what its known links determine (a root
        // only has outflow, a leaf only inflow). No measurement and no known link means genuinely unknown —
        // reported as null rather than 0, so nothing downstream can mistake "we don't know" for "it's zero".
        double? ValueOf(string id)
        {
            if (leaf.TryGetValue(id, out var measured)) return measured;

            double inflow = 0, outflow = 0;
            var anyKnown = false;
            foreach (var l in links)
            {
                if (!l.Known) continue;
                if (string.Equals(l.Target, id, StringComparison.OrdinalIgnoreCase)) { inflow += l.Value; anyKnown = true; }
                if (string.Equals(l.Source, id, StringComparison.OrdinalIgnoreCase)) { outflow += l.Value; anyKnown = true; }
            }
            return anyKnown ? Math.Max(inflow, outflow) : null;
        }

        // Every node the user declared, plus every auto (pdu/outlet) node that reported a measurement —
        // whether or not a value could be determined for it. A configured node that silently disappears is
        // its own kind of inaccuracy: it reads as "my config is broken" rather than "nothing measures this".
        var nodes = label.Keys
            .Where(id => wired.Contains(id) || leaf.ContainsKey(id))
            .Select(id => new FlowNode(id, label[id], kind.TryGetValue(id, out var k) ? k : "node", ValueOf(id)))
            .OrderBy(n => n.Id, StringComparer.OrdinalIgnoreCase)
            .ToList();

        return new FlowGraph(nodes, links, metric, units);
    }
}
