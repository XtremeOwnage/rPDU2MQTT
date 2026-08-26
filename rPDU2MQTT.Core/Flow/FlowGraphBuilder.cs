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
    /// </summary>
    public static IReadOnlyList<EnergyFlowLink> NestGroupMembers(EnergyFlowConfig flow)
    {
        if (flow.Groups.Count == 0 || flow.Links.Count == 0) return flow.Links;

        // A member only nests under an anchor that is itself a node in the graph.
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
            // Only rewrite when the anchor demonstrably feeds the same target.
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

        // Add an edge only if it keeps the graph acyclic.
        bool AddEdgeSafe(string from, string to)
        {
            if (string.Equals(from, to, StringComparison.OrdinalIgnoreCase)) return false;  // self-loop
            if (Reaches(to, from)) return false;                                            // would close a cycle
            AddEdge(from, to);
            return true;
        }

        // Nodes the user has explicitly wired a feeder for (via Links or legacy Parents).
        var explicitlyFed = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var l in flow.Links) if (!string.IsNullOrEmpty(l.To)) explicitlyFed.Add(l.To);
        foreach (var child in flow.Parents.Keys) if (!string.IsNullOrEmpty(child)) explicitlyFed.Add(child);

        // Auto-derived base flow: each PDU feeds its outlets, weighted by the chosen measurement.
        foreach (var device in data.Devices)
        {
            var pduId = FlowNodeId.ForPdu(device.Entity_Name);
            foreach (var outlet in device.Outlets)
            {
                var outletId = FlowNodeId.ForOutlet(device.Entity_Name, outlet.Key);
                var m = outlet.Measurements.FirstOrDefault(x => string.Equals(x.Type, metric, StringComparison.OrdinalIgnoreCase));

                double value;
                // An exclusive source answers for every node or not at all: the snapshot is what the device
                // reads NOW, and dropping it into a view of an hour ago is how a past instant ends up half
                // then and half now with nothing marking which is which.
                if (live is { Exclusive: true })
                {
                    if (!live.TryGetValue(outletId, metric, out var stored)) continue;
                    value = stored;
                    if (string.IsNullOrEmpty(units)) units = FlowUnits.Canonical(metric);
                }
                else if (m is not null && double.TryParse(m.Value, System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out var reported))
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

                // A switched-off outlet reads 0, and that is a fact about it — the outlet is there and it
                // is drawing nothing. Dropping it made its series vanish from every export, so a consumer
                // could not tell "switched off" from "stopped reporting", and an energy dashboard saw a gap
                // where it should have seen a flat zero. A negative reading is a different matter (see
                // NegativeReading below); it cannot flow forwards, so it is still not a leaf.
                if (value < 0) continue;

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

        // Custom upstream nodes (#129).
        foreach (var n in flow.Nodes)
            if (!string.IsNullOrEmpty(n.Id))
            {
                label[n.Id] = string.IsNullOrEmpty(n.Label) ? n.Id : n.Label;
                // The node's declared kind (battery, inverter, panel, …) styles the diagram.
                if (!kind.ContainsKey(n.Id)) kind[n.Id] = string.IsNullOrWhiteSpace(n.Kind) ? "node" : n.Kind.Trim().ToLowerInvariant();
                // Tags travel with the node so a view can filter on them (#342).
                var tagged = (n.Tags ?? [])
                    .Select(t => t?.Trim() ?? "")
                    .Where(t => t.Length > 0)
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .ToList();
                if (tagged.Count > 0) tags[n.Id] = tagged;
                if (live is not null && live.TryGetValue(n.Id, metric, out var liveValue))
                {
                    // A live reading is authoritative even at 0: solar at night generates nothing.
                    leaf[n.Id] = Math.Max(0, liveValue);
                }
                // The static Value is a power figure (watts) — the field is offered and labelled as one.
                // Applying it to every graph published a 5000 W node as 5000 kWh of energy, and 5000 kWh
                // used today, which then flowed into the exports and the history behind them.
                else if (n.Value is > 0 && string.Equals(metric, DefaultMetric, StringComparison.OrdinalIgnoreCase))
                    leaf[n.Id] = n.Value.Value;
            }

        // Custom directed links (From feeds To) plus legacy Parents (parent feeds child).
        var wiredEdges = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        static string EdgeKey(string from, string to) => from + "␟" + to;
        foreach (var l in NestGroupMembers(flow))
            if (!string.IsNullOrEmpty(l.From) && !string.IsNullOrEmpty(l.To) && label.ContainsKey(l.From) && label.ContainsKey(l.To))
                if (AddEdgeSafe(l.From, l.To)) wiredEdges.Add(EdgeKey(l.From, l.To));
        foreach (var (child, parent) in flow.Parents)
            if (!string.IsNullOrEmpty(child) && !string.IsNullOrEmpty(parent) && label.ContainsKey(child) && label.ContainsKey(parent))
                if (AddEdgeSafe(parent, child)) wiredEdges.Add(EdgeKey(parent, child));
        bool Wired(string from, string to) => wiredEdges.Contains(EdgeKey(from, to));

        // Which feeders point into each node.
        var incoming = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
        foreach (var (from, kids) in outgoing)
            foreach (var to in kids)
            {
                if (!incoming.TryGetValue(to, out var fs)) incoming[to] = fs = new();
                fs.Add(from);
            }

        // Per-node value mode (#129): governs how an unmeasured node is valued.
        var mode = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var n in flow.Nodes)
            if (!string.IsNullOrEmpty(n.Id))
                mode[n.Id] = string.IsNullOrWhiteSpace(n.Mode) ? "auto" : n.Mode.Trim().ToLowerInvariant();
        string Mode(string id) => mode.TryGetValue(id, out var m) ? m : "auto";

        // Need(id): power this node must receive = its known value (outlet sink or producer).
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
        // Demand a single child draws through one of its feeders, split if it has several.
        double DemandShare(string child, HashSet<string> path)
            => Need(child, path) / Math.Max(1, incoming.TryGetValue(child, out var f) ? f.Count : 1);

        // A 'none' node never infers a value.
        static bool Inert(string m) => m is "none" or "static";

        // What a node's leftover should be CALLED. Power a panel carries beyond its metered circuits is
        // load nobody is metering; power an inverter or the grid puts out beyond what the modelled paths
        // account for is output going somewhere this hierarchy does not describe. Same arithmetic, and
        // calling the second one "load" on the thing producing it reads as a fault that is not there.
        bool Produces(string id)
            => kind.TryGetValue(id, out var k) && k is "solar" or "grid" or "battery" or "inverter";

        // A node whose reading is power arriving to be shared out among things that meter themselves: a
        // panel, a PDU, a metered circuit. Named kinds only — an unclassified node says nothing either way
        // and keeps conservation down a single path; set its Kind to say what it is.
        bool Distributes(string id)
            => kind.TryGetValue(id, out var k) && k is "panel" or "pdu" or "outlet" or "load";

        // Which unmeasured feeders may supply what a node still needs after its measured feeders are counted.
        var expectsReading = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var n in flow.Nodes)
        {
            if (string.IsNullOrEmpty(n.Id) || leaf.ContainsKey(n.Id)) continue;
            // Metric-specific on purpose: a node bound only for realpower is not failing to report energy.
            if (n.AllSources().Any(src => string.Equals(
                    FlowMetricKey.ForAccumulation(src.Metric ?? "", src.Accumulation), metric, StringComparison.OrdinalIgnoreCase)))
                expectsReading.Add(n.Id);
        }
        bool Unavailable(string id) => expectsReading.Contains(id);

        // Every node that ended up carrying a conservation back-fill.
        var inferred = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        // Did this node have a CHOICE of feeders? That is the line between a roll-up and an attribution.
        bool HasAlternatives(string to)
            => (incoming.TryGetValue(to, out var fs) ? fs.Count : 0) > 1;

        List<string> Absorbers(string to)
        {
            // Switched off: an attribution among alternatives is not made.
            if (HasAlternatives(to) && !flow.InferFromConservation) return new List<string>();

            var feeders = incoming.TryGetValue(to, out var fs) ? fs : new List<string>();
            var unmeasured = feeders.Where(f => !leaf.ContainsKey(f) && !Inert(Mode(f)) && !Unavailable(f)).ToList();
            var residual = unmeasured.Where(f => Mode(f) == "residual").ToList();
            if (residual.Count > 0) return residual;
            return unmeasured.Count == 1 ? unmeasured : new List<string>();
        }

        // Is the flow along this link determined by measurements at all?
        bool Knowable(string from, string to)
        {
            // An intensive metric — voltage, frequency, power factor, state of charge, temperature.
            if (!FlowUnits.IsAdditive(metric)) return false;

            if (leaf.ContainsKey(from)) return true;         // a measured producer supplies a real figure
            if (Inert(Mode(from))) return true;              // 'none'/'static': deliberately contributes nothing

            // A feeder whose own source has stopped reporting carries an unknowable amount — not zero.
            if (Unavailable(from)) return false;

            var feeders = incoming.TryGetValue(to, out var fs) ? fs : new List<string>();
            var unmeasured = feeders.Where(f => !leaf.ContainsKey(f) && !Inert(Mode(f)) && !Unavailable(f)).ToList();

            // A designated residual is told what it carries, so its own flow is determined.
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

                // A metered circuit draws what its own clamp says, not a share of its parent scaled to
                // make the total add up. That scaling replaced a measurement with arithmetic: a 1,418 W
                // sub-panel feeding a 1.8 W circuit and a 1.2 W circuit drew the water heater at 845 W —
                // a figure nothing reported, 477x its own reading, and a ribbon that dwarfed the panel.
                // What the parent carries beyond its metered circuits is unmeasured load, named as such
                // below rather than pushed onto whichever circuits happen to be metered.
                //
                // Only TERMINAL children qualify. A measured child with children of its own is a
                // pass-through whose reading may be on one leg — the inverter bound to load_power while
                // also charging a battery — so conservation, not its reading, governs what reaches it.
                //
                // Only where there is something to apportion. Down a SINGLE path conservation is sound and
                // is the only thing that can be said: 750 W of solar feeding one outlet puts 750 W on that
                // link, and a shortfall against the outlet's own reading is a gap in the topology. It is
                // the splitting across several children that must not overwrite their meters — including
                // children that are themselves panels, which is where this bit hardest: an inverter
                // reading 6.97 kW pushed 2.9 kW and 4.1 kW into two panels metering 1.04 kW and 1.47 kW,
                // so each panel's bar was drawn nearly three times its own reading.
                // …and, for a node that DISTRIBUTES, even when there is only one child: a 1,040 W panel
                // feeding one circuit metered at 90 W is the same overwrite with one child instead of six.
                // Out of a PRODUCER down a single path, conservation is still the only thing that can be
                // said, so that case keeps it.
                var metered = kids.Count > 1 || Distributes(from)
                    ? kids.Where(leaf.ContainsKey).ToList()
                    : new List<string>();
                if (metered.Count > 0)
                {
                    var meteredDraw = metered.Sum(c => DemandShare(c, path));
                    // What the parent emits is still the ceiling: a link cannot carry more than its source
                    // produces, so meters asking for more than there is are scaled to fit.
                    var fit = meteredDraw > produced && meteredDraw > 0 ? produced / meteredDraw : 1.0;

                    if (metered.Contains(to, StringComparer.OrdinalIgnoreCase)) return DemandShare(to, path) * fit;
                    if (Inert(Mode(to))) return 0;

                    // Whatever the metered children leave is divided among the ones nothing measures.
                    var estimated = kids.Where(c => !metered.Contains(c, StringComparer.OrdinalIgnoreCase) && !Inert(Mode(c))).ToList();
                    if (estimated.Count == 0) return 0;
                    var spare = Math.Max(0, produced - meteredDraw * fit);
                    var demand = estimated.Sum(c => Need(c, path));
                    return demand > 0 ? spare * Need(to, path) / demand : spare / estimated.Count;
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
            // Only an attribution gets the label.
            if (share > 0 && HasAlternatives(to)) inferred.Add(from);
            return share;
        }

        // Every edge the topology has, valued by the flow it carries. This is what the graph KNOWS; the
        // list below is what it DRAWS, and they are not the same — a zero-width ribbon is not worth drawing,
        // but it is still the reason a node's value is zero rather than unknown.
        var edges = new List<FlowLink>();
        var links = new List<FlowLink>();
        // Every node the topology wires up, whether or not its link survives the filter below.
        var wired = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var (from, kids) in outgoing)
            foreach (var to in kids)
            {
                wired.Add(from); wired.Add(to);

                var known = Knowable(from, to);
                var value = known ? EdgeFlow(from, to, new HashSet<string>(StringComparer.OrdinalIgnoreCase)) : 0;
                edges.Add(new FlowLink(from, to, value, known));

                // A known-but-zero link is normally left off the diagram, unless dropping it would detach the chain below.
                var passThroughZero = Wired(from, to) && incoming.TryGetValue(from, out var upstream) && upstream.Count > 0;

                // The same reasoning one step earlier, for the link into an inert node that sits mid-chain.
                var midChainInert = Inert(Mode(to)) && outgoing.TryGetValue(to, out var below) && below.Count > 0;

                // A measured-zero LEAF stays attached: it is reported now, so leaving its edge out would
                // float it off the diagram with no parent and cost it its tier label in the exports. The
                // ribbon is zero-width either way — this is about the node being placed, not drawn. A node
                // with something below it is a different case, handled by passThroughZero above.

                var measuredZeroLeaf = leaf.ContainsKey(to)
                    && !(outgoing.TryGetValue(to, out var beneath) && beneath.Count > 0);

                if (known && value <= 0 && !passThroughZero && !midChainInert && !measuredZeroLeaf) continue;

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
                label[sinkId] = FlowMetricKey.ReturnLabel(label.TryGetValue(n.Id, out var nl) ? nl : n.Id, k);
                kind[sinkId] = k;
                leaf[sinkId] = drawn;
                // The same tags as the node it belongs to.
                if (tags.TryGetValue(n.Id, out var nt)) tags[sinkId] = nt;
                links.Add(new FlowLink(hub, sinkId, drawn, true));
                edges.Add(new FlowLink(hub, sinkId, drawn, true));
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
            label[uid] = Produces(id) ? "Unaccounted output" : "Unmeasured load";
            kind[uid] = "unmeasured";
            leaf[uid] = gap;
            unmeasured.Add(new FlowLink(id, uid, gap, true));
        }
        foreach (var l in unmeasured) { links.Add(l); edges.Add(l); wired.Add(l.Source); wired.Add(l.Target); }

        // A node's own value: its measurement if it has one.
        double? ValueOf(string id)
        {
            if (leaf.TryGetValue(id, out var measured)) return measured;

            var (inflow, outflow, anyIn, anyOut) = Sides(id);
            return anyIn || anyOut ? Math.Max(inflow, outflow) : null;
        }

        // What this node's known edges say arrives at it and leaves it. Read from the topology, not from
        // the drawn links: whether a ribbon was worth drawing has nothing to do with what is true.
        //
        // A zero edge only counts as knowledge when the node at the far end is itself measured. Otherwise
        // "a link exists" gets read as "the value is known", and a node whose only source said it did not
        // know — an unavailable Home Assistant entity, say — comes out as a confident zero.
        (double In, double Out, bool AnyIn, bool AnyOut) Sides(string id)
        {
            double inflow = 0, outflow = 0;
            bool anyIn = false, anyOut = false;
            foreach (var l in edges)
            {
                if (!l.Known) continue;
                var intoMe = string.Equals(l.Target, id, StringComparison.OrdinalIgnoreCase);
                var outOfMe = string.Equals(l.Source, id, StringComparison.OrdinalIgnoreCase);
                if (!intoMe && !outOfMe) continue;

                var farEnd = intoMe ? l.Source : l.Target;
                if (l.Value <= 0 && !leaf.ContainsKey(farEnd)) continue;

                if (intoMe) { inflow += l.Value; anyIn = true; }
                if (outOfMe) { outflow += l.Value; anyOut = true; }
            }
            return (inflow, outflow, anyIn, anyOut);
        }

        // Outflow a node's supply cannot account for.
        double? ImbalanceOf(string id)
        {
            var (inflow, outflow, anyIn, anyOut) = Sides(id);
            if (!anyIn || !anyOut) return null;

            // A node whose own reading is smaller than what passes through it is NOT contradicted.
            var gap = outflow - inflow;
            // Rounding noise and honest conversion loss are not contradictions.
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

        // Where a node's number came from.
        string DerivationOf(string id)
        {
            if (leaf.ContainsKey(id)) return FlowDerivation.Measured;
            if (ValueOf(id) is null) return FlowDerivation.Unknown;
            // A node that absorbed a remainder is inferred even if it also sums children.
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
