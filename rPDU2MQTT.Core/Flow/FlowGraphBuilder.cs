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

    /// <summary>
    /// Where a group's anchor node feeds a target and its members feed that same target, re-point the
    /// members at the anchor so the chain reads members → anchor → target.
    ///
    /// </summary>
    public static IReadOnlyList<EnergyFlowLink> NestGroupMembers(EnergyFlowConfig flow)
    {
        if (flow.Groups.Count == 0 || flow.Links.Count == 0) return flow.Links;

        // A member only nests under an anchor that is itself a node in the graph; a purely synthetic group
        var nodeIds = new HashSet<string>(flow.Nodes.Select(n => n.Id ?? ""), StringComparer.OrdinalIgnoreCase);
        var anchorOf = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var g in flow.Groups)
        {
            if (string.IsNullOrEmpty(g.Id) || !nodeIds.Contains(g.Id)) continue;
            foreach (var m in g.Members)
                if (!string.IsNullOrEmpty(m) && !string.Equals(m, g.Id, StringComparison.OrdinalIgnoreCase))
                    anchorOf[m] = g.Id;
        }
        if (anchorOf.Count == 0) return flow.Links;

        var anchorFeeds = new HashSet<string>(
            flow.Links.Where(l => !string.IsNullOrEmpty(l.From) && anchorOf.Values.Contains(l.From, StringComparer.OrdinalIgnoreCase))
                      .Select(l => l.From + "␟" + l.To),
            StringComparer.OrdinalIgnoreCase);

        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var result = new List<EnergyFlowLink>(flow.Links.Count);
        foreach (var l in flow.Links)
        {
            var from = l.From ?? ""; var to = l.To ?? "";
            // Only rewrite when the anchor demonstrably feeds the same target — otherwise this member's
            if (anchorOf.TryGetValue(from, out var anchor) && anchorFeeds.Contains(anchor + "␟" + to))
                to = anchor;
            if (string.Equals(from, to, StringComparison.OrdinalIgnoreCase)) continue;   // member already fed its anchor
            if (!seen.Add(from + "␟" + to)) continue;                                    // rewriting can collide
            result.Add(new EnergyFlowLink { From = from, To = to });
        }
        return result;
    }

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
        var tags = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
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
        bool AddEdgeSafe(string from, string to)
        {
            if (string.Equals(from, to, StringComparison.OrdinalIgnoreCase)) return false;  // self-loop
            if (Reaches(to, from)) return false;                                            // would close a cycle
            AddEdge(from, to);
            return true;
        }

        // Nodes the user has explicitly wired a feeder for (via Links or legacy Parents) — their auto
        var explicitlyFed = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var l in flow.Links) if (!string.IsNullOrEmpty(l.To)) explicitlyFed.Add(l.To);
        foreach (var child in flow.Parents.Keys) if (!string.IsNullOrEmpty(child)) explicitlyFed.Add(child);

        // Auto-derived base flow: each PDU feeds its outlets, weighted by the chosen measurement.
        foreach (var device in data.Devices)
        {
            var pduId = $"pdu:{device.Entity_Name}";
            foreach (var outlet in device.Outlets)
            {
                var outletId = $"outlet:{device.Entity_Name}:{outlet.Key}";
                var m = outlet.Measurements.FirstOrDefault(x => string.Equals(x.Type, metric, StringComparison.OrdinalIgnoreCase));

                double value;
                if (m is not null && double.TryParse(m.Value, System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out var reported))
                {
                    value = reported;
                    if (string.IsNullOrEmpty(units)) units = m.Units;
                }
                // A metric the PDU doesn't report natively but that something derives for this outlet —
                else if (live is not null && live.TryGetValue(outletId, metric, out var derived))
                {
                    value = derived;
                    if (string.IsNullOrEmpty(units)) units = FlowUnits.Canonical(metric);
                }
                else continue;

                if (value <= 0) continue;

                label[outletId] = outlet.Entity_DisplayName; kind[outletId] = "outlet"; leaf[outletId] = value;
                label[pduId] = device.Entity_DisplayName; kind[pduId] = "pdu";
                // Derived nodes have no config entry to carry tags, so theirs come from the rules (#342).
                var outletTags = AutoTags.For(flow.AutoTags, outletId);
                if (outletTags.Count > 0) tags[outletId] = outletTags.ToList();
                var pduTags = AutoTags.For(flow.AutoTags, pduId);
                if (pduTags.Count > 0) tags[pduId] = pduTags.ToList();
                // Skip the auto PDU link when the user has wired an explicit feeder for this outlet.
                if (!explicitlyFed.Contains(outletId))
                    AddEdge(pduId, outletId);
            }
        }

        // Custom upstream nodes (#129). A node is a leaf source when it has a value of its own: a live
        foreach (var n in flow.Nodes)
            if (!string.IsNullOrEmpty(n.Id))
            {
                label[n.Id] = string.IsNullOrEmpty(n.Label) ? n.Id : n.Label;
                // The node's declared kind (battery, inverter, panel, …) styles the diagram; fall back to
                if (!kind.ContainsKey(n.Id)) kind[n.Id] = string.IsNullOrWhiteSpace(n.Kind) ? "node" : n.Kind.Trim().ToLowerInvariant();
                // Tags travel with the node so a view can filter on them (#342). Trimmed, blanks dropped and
                var tagged = (n.Tags ?? [])
                    .Select(t => t?.Trim() ?? "")
                    .Where(t => t.Length > 0)
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .ToList();
                if (tagged.Count > 0) tags[n.Id] = tagged;
                if (live is not null && live.TryGetValue(n.Id, metric, out var liveValue))
                {
                    // A live reading is authoritative even at 0: solar at night generates nothing, and the
                    leaf[n.Id] = Math.Max(0, liveValue);
                }
                else if (n.Value is > 0) leaf[n.Id] = n.Value.Value;
            }

        // Custom directed links (From feeds To) plus legacy Parents (parent feeds child) — only when both
        var wiredEdges = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        static string EdgeKey(string from, string to) => from + "␟" + to;
        foreach (var l in NestGroupMembers(flow))
            if (!string.IsNullOrEmpty(l.From) && !string.IsNullOrEmpty(l.To) && label.ContainsKey(l.From) && label.ContainsKey(l.To))
                if (AddEdgeSafe(l.From, l.To)) wiredEdges.Add(EdgeKey(l.From, l.To));
        foreach (var (child, parent) in flow.Parents)
            if (!string.IsNullOrEmpty(child) && !string.IsNullOrEmpty(parent) && label.ContainsKey(child) && label.ContainsKey(parent))
                if (AddEdgeSafe(parent, child)) wiredEdges.Add(EdgeKey(parent, child));
        bool Wired(string from, string to) => wiredEdges.Contains(EdgeKey(from, to));

        // Which feeders point into each node — used to split a node's demand across them (so a node
        var incoming = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
        foreach (var (from, kids) in outgoing)
            foreach (var to in kids)
            {
                if (!incoming.TryGetValue(to, out var fs)) incoming[to] = fs = new();
                fs.Add(from);
            }

        // Per-node value mode (#129): governs how an unmeasured node is valued. A node with a live/static
        var mode = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var n in flow.Nodes)
            if (!string.IsNullOrEmpty(n.Id))
                mode[n.Id] = string.IsNullOrWhiteSpace(n.Mode) ? "auto" : n.Mode.Trim().ToLowerInvariant();
        string Mode(string id) => mode.TryGetValue(id, out var m) ? m : "auto";

        // Need(id): power this node must receive = its known value (outlet sink or producer), else the sum
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
        double DemandShare(string child, HashSet<string> path)
            => Need(child, path) / Math.Max(1, incoming.TryGetValue(child, out var f) ? f.Count : 1);

        // A 'none' node never infers a value, and a 'static' node with no value here (a valued one is
        static bool Inert(string m) => m is "none" or "static";

        // Which unmeasured feeders may supply what a node still needs after its measured feeders have
        var expectsReading = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var n in flow.Nodes)
        {
            if (string.IsNullOrEmpty(n.Id) || leaf.ContainsKey(n.Id)) continue;
            // Metric-specific on purpose: a node bound only for realpower is not "failing" to report energy,
            if (n.AllSources().Any(src => string.Equals(
                    FlowMetricKey.ForAccumulation(src.Metric ?? "", src.Accumulation), metric, StringComparison.OrdinalIgnoreCase)))
                expectsReading.Add(n.Id);
        }
        bool Unavailable(string id) => expectsReading.Contains(id);

        // Every node that ended up carrying a conservation back-fill, so its value can be labelled `inferred`
        var inferred = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        // Did this node have a CHOICE of feeders? That is the line between a roll-up and an attribution.
        bool HasAlternatives(string to)
            => (incoming.TryGetValue(to, out var fs) ? fs.Count : 0) > 1;

        List<string> Absorbers(string to)
        {
            // Switched off: an attribution among alternatives is not made, and the node reads "no data"
            if (HasAlternatives(to) && !flow.InferFromConservation) return new List<string>();

            var feeders = incoming.TryGetValue(to, out var fs) ? fs : new List<string>();
            var unmeasured = feeders.Where(f => !leaf.ContainsKey(f) && !Inert(Mode(f)) && !Unavailable(f)).ToList();
            var residual = unmeasured.Where(f => Mode(f) == "residual").ToList();
            if (residual.Count > 0) return residual;
            return unmeasured.Count == 1 ? unmeasured : new List<string>();
        }

        // Is the flow along this link determined by measurements at all? False when several unmeasured
        bool Knowable(string from, string to)
        {
            // An intensive metric — voltage, frequency, power factor, state of charge, temperature — does
            if (!FlowUnits.IsAdditive(metric)) return false;

            if (leaf.ContainsKey(from)) return true;         // a measured producer supplies a real figure
            if (Inert(Mode(from))) return true;              // 'none'/'static': deliberately contributes nothing

            // A feeder whose own source has stopped reporting carries an unknowable amount — not zero. Its
            if (Unavailable(from)) return false;

            var feeders = incoming.TryGetValue(to, out var fs) ? fs : new List<string>();
            var unmeasured = feeders.Where(f => !leaf.ContainsKey(f) && !Inert(Mode(f)) && !Unavailable(f)).ToList();

            // A designated residual is told what it carries, so its own flow is determined. Its unmeasured
            if (unmeasured.Any(f => Mode(f) == "residual")) return Mode(from) == "residual";

            // One unmeasured path is determined by conservation. Several is a real unknown.
            if (HasAlternatives(to) && !flow.InferFromConservation) return false;
            return unmeasured.Count <= 1;
        }

        // EdgeFlow(from -> to): how much flows along one link.
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
            var share = remainder / absorbers.Count;
            // Only an attribution gets the label. Where this feeder was the only route, the figure is the
            if (share > 0 && HasAlternatives(to)) inferred.Add(from);
            return share;
        }

        // Emit one link per edge, valued by the flow it carries. A link whose flow is *unknowable* is still
        var links = new List<FlowLink>();
        // Every node the topology wires up, whether or not its link survives the filter below. Deriving the
        var wired = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var (from, kids) in outgoing)
            foreach (var to in kids)
            {
                wired.Add(from); wired.Add(to);

                var known = Knowable(from, to);
                var value = known ? EdgeFlow(from, to, new HashSet<string>(StringComparer.OrdinalIgnoreCase)) : 0;

                // A known-but-zero link is normally left off the diagram (an idle outlet, or a pure source
                var passThroughZero = Wired(from, to) && incoming.TryGetValue(from, out var upstream) && upstream.Count > 0;

                // The same reasoning one step earlier, for the link *into* an inert ('none', or valueless
                var midChainInert = Inert(Mode(to)) && outgoing.TryGetValue(to, out var below) && below.Count > 0;

                if (known && value <= 0 && !passThroughZero && !midChainInert) continue;

                links.Add(new FlowLink(from, to, value, known));
            }

        // The return lane: a battery being charged, a grid being exported to.
        if (live is not null)
        {
            var inKey = FlowMetricKey.For(metric, "in");
            foreach (var n in flow.Nodes)
            {
                if (string.IsNullOrEmpty(n.Id) || !outgoing.TryGetValue(n.Id, out var fed) || fed.Count == 0) continue;
                if (!live.TryGetValue(n.Id, inKey, out var drawn) || drawn <= 0) continue;

                // Attach it where the node sends its supply, so the pair sits either side of one hub.
                var hub = fed[0];
                var sinkId = n.Id + FlowMetricKey.InSuffix;
                var k = kind.TryGetValue(n.Id, out var nk) ? nk : "node";
                label[sinkId] = (label.TryGetValue(n.Id, out var nl) ? nl : n.Id)
                    + (k == "battery" ? " (charging)" : k == "grid" ? " (export)" : " (in)");
                kind[sinkId] = k;
                leaf[sinkId] = drawn;
                // The same tags as the node it belongs to: a filter that keeps the battery must keep its
                if (tags.TryGetValue(n.Id, out var nt)) tags[sinkId] = nt;
                links.Add(new FlowLink(hub, sinkId, drawn, true));
                wired.Add(hub); wired.Add(sinkId);
            }
        }

        // Name the load nobody is metering, instead of drawing it as a blank slab.
        var unmeasured = new List<FlowLink>();
        foreach (var id in outgoing.Keys)
        {
            double inflow = 0, outflow = 0;
            bool anyIn = false, anyOut = false;
            foreach (var l in links)
            {
                if (!l.Known) continue;
                if (string.Equals(l.Target, id, StringComparison.OrdinalIgnoreCase)) { inflow += l.Value; anyIn = true; }
                if (string.Equals(l.Source, id, StringComparison.OrdinalIgnoreCase)) { outflow += l.Value; anyOut = true; }
            }
            if (!anyOut) continue;
            // What the node actually passes: its own measurement if it has one, else what reached it.
            double total = leaf.TryGetValue(id, out var measured) ? measured : (anyIn ? inflow : 0);
            var gap = total - outflow;
            if (total <= 0 || gap <= 1 || gap <= total * 0.02) continue;

            var uid = id + "#unmeasured";
            label[uid] = "Unmeasured load";
            kind[uid] = "unmeasured";
            leaf[uid] = gap;
            unmeasured.Add(new FlowLink(id, uid, gap, true));
        }
        foreach (var l in unmeasured) { links.Add(l); wired.Add(l.Source); wired.Add(l.Target); }

        // A node's own value: its measurement if it has one, else what its known links determine (a root
        double? ValueOf(string id)
        {
            if (leaf.TryGetValue(id, out var measured)) return measured;

            var (inflow, outflow, anyIn, anyOut) = Sides(id);
            return anyIn || anyOut ? Math.Max(inflow, outflow) : null;
        }

        // What this node's known links say arrives at it and leaves it.
        (double In, double Out, bool AnyIn, bool AnyOut) Sides(string id)
        {
            double inflow = 0, outflow = 0;
            bool anyIn = false, anyOut = false;
            foreach (var l in links)
            {
                if (!l.Known) continue;
                if (string.Equals(l.Target, id, StringComparison.OrdinalIgnoreCase)) { inflow += l.Value; anyIn = true; }
                if (string.Equals(l.Source, id, StringComparison.OrdinalIgnoreCase)) { outflow += l.Value; anyOut = true; }
            }
            return (inflow, outflow, anyIn, anyOut);
        }

        // Outflow a node's supply cannot account for. Only where both sides are actually determined: a root
        double? ImbalanceOf(string id)
        {
            var (inflow, outflow, anyIn, anyOut) = Sides(id);
            if (!anyIn || !anyOut) return null;

            // A node whose own reading is smaller than what passes through it is NOT contradicted. An
            var gap = outflow - inflow;
            // Rounding noise and honest conversion loss are not contradictions; 2% matches the floor the
            return gap > 1 && gap > inflow * 0.02 ? gap : null;
        }

        // What actually passes through a measured node, when its own reading covers less than that.
        double? ThroughputOf(string id)
        {
            if (!leaf.TryGetValue(id, out var reading)) return null;
            var (inflow, outflow, anyIn, anyOut) = Sides(id);
            if (!anyIn || !anyOut) return null;
            var throughput = Math.Max(inflow, outflow);
            var over = throughput - reading;
            return over > 1 && over > reading * 0.02 ? throughput : null;
        }

        // Where a node's number came from. Provenance travels with the value so no consumer has to guess,
        string DerivationOf(string id)
        {
            if (leaf.ContainsKey(id)) return FlowDerivation.Measured;
            if (ValueOf(id) is null) return FlowDerivation.Unknown;
            // A node that absorbed a remainder is inferred even if it also sums children — the back-fill is
            return inferred.Contains(id) ? FlowDerivation.Inferred : FlowDerivation.Summed;
        }

        // Every node the user declared, plus every auto (pdu/outlet) node that reported a measurement —
        var nodes = label.Keys
            .Where(id => wired.Contains(id) || leaf.ContainsKey(id))
            .Select(id => new FlowNode(id, label[id], kind.TryGetValue(id, out var k) ? k : "node",
                                       ValueOf(id), ImbalanceOf(id), DerivationOf(id),
                                       tags.TryGetValue(id, out var t) ? t : null, ThroughputOf(id)))
            .OrderBy(n => n.Id, StringComparer.OrdinalIgnoreCase)
            .ToList();

        return new FlowGraph(nodes, links, metric, units);
    }
}
