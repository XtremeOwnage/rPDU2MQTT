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
    /// <para>
    /// A group whose Id is also a real node is an "anchor": it carries its own measured reading, and that
    /// reading already <em>is</em> the members' total. Linking both the anchor and each member into the
    /// same target therefore delivers the same energy twice. Seen on a live system: an inverter fed by
    /// Solar (4947 W) and by MPPT_1/2/3 (2292 + 2655 + 0 = the same 4947 W), so the diagram showed 9894 W
    /// of PV arriving at a node drawing 8629 W — supply exceeding the load it supplies, which is not a
    /// state the hardware can be in.
    /// </para>
    /// <para>
    /// Collapsing the group did not help: folding the members onto the anchor merged the duplicate links
    /// into one, concentrating the doubled value on a single link rather than removing it, and the
    /// inflated column total rescaled the whole diagram.
    /// </para>
    /// <para>
    /// Nesting is the honest reading of the topology — the strings feed the array, the array feeds the
    /// inverter — and it makes collapsing purely visual: the totals are identical either way. Members that
    /// feed a target the anchor does <em>not</em> feed are left alone; that is a real, separate path.
    /// </para>
    /// </summary>
    public static IReadOnlyList<EnergyFlowLink> NestGroupMembers(EnergyFlowConfig flow)
    {
        if (flow.Groups.Count == 0 || flow.Links.Count == 0) return flow.Links;

        // A member only nests under an anchor that is itself a node in the graph; a purely synthetic group
        // (no node of its own) has no reading to double-count, so its members keep their links.
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
            // link describes a path the anchor does not cover, and dropping it would lose real topology.
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
                var outletId = $"outlet:{device.Entity_Name}:{outlet.Key}";
                var m = outlet.Measurements.FirstOrDefault(x => string.Equals(x.Type, metric, StringComparison.OrdinalIgnoreCase));

                double value;
                if (m is not null && double.TryParse(m.Value, System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out var reported))
                {
                    value = reported;
                    if (string.IsNullOrEmpty(units)) units = m.Units;
                }
                // A metric the PDU doesn't report natively but that something derives for this outlet —
                // today the daily total, which the aggregator keeps for outlets precisely so they can be
                // compared with the rest of the graph instead of contradicting it. Without this fallback the
                // whole PDU side simply vanishes from any such metric's diagram.
                else if (live is not null && live.TryGetValue(outletId, metric, out var derived))
                {
                    value = derived;
                    if (string.IsNullOrEmpty(units)) units = FlowUnits.Canonical(metric);
                }
                else continue;

                if (value <= 0) continue;

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
                // Tags travel with the node so a view can filter on them (#342). Trimmed, blanks dropped and
                // de-duplicated case-insensitively, because they are hand-typed and "Rack 1" arriving twice
                // as two chips is just noise. They never take part in any calculation.
                var tagged = (n.Tags ?? [])
                    .Select(t => t?.Trim() ?? "")
                    .Where(t => t.Length > 0)
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .ToList();
                if (tagged.Count > 0) tags[n.Id] = tagged;
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
        // Track which edges the user wired by hand: unlike the auto PDU → outlet links, these must stay on
        // the diagram even when their computed flow is zero, so the topology someone deliberately drew (e.g.
        // Solar → inverter → GridBoss) always renders as a connected chain — a mid-chain node that happens to
        // read 0 W must not silently detach everything downstream of it.
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
        // Nodes that are SUPPOSED to report this metric — someone bound a source for it — but have no fresh
        // reading right now. "Unmeasured" and "unavailable" are not the same thing, and conflating them is how
        // the diagram invented solar generation in the dark.
        //
        // A node with no source bound is genuinely unmeasured: nothing was ever going to measure it, so if the
        // topology leaves exactly one path for the load to arrive by, conservation really does determine it.
        // A node with a source bound and nothing coming out of it is a different situation entirely — the
        // measurement failed. Letting it absorb the remainder says "we don't know what solar was doing, so
        // assume it was doing all of it", which on a live system at night attributed the entire house load to
        // a PV array in the dark while the grid that was actually carrying it read "no data".
        //
        // The project's rule is that unknown is never zero. This is the same rule pointing the other way:
        // unknown is never "whatever balances the equation" either.
        var expectsReading = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var n in flow.Nodes)
        {
            if (string.IsNullOrEmpty(n.Id) || leaf.ContainsKey(n.Id)) continue;
            // Metric-specific on purpose: a node bound only for realpower is not "failing" to report energy,
            // it was never asked to. Only a binding for THIS metric makes silence a failure.
            if (n.AllSources().Any(src => string.Equals(
                    FlowMetricKey.ForAccumulation(src.Metric ?? "", src.Accumulation), metric, StringComparison.OrdinalIgnoreCase)))
                expectsReading.Add(n.Id);
        }
        bool Unavailable(string id) => expectsReading.Contains(id);

        // Every node that ended up carrying a conservation back-fill, so its value can be labelled `inferred`
        // rather than presented the way a metered one is.
        var inferred = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        // Did this node have a CHOICE of feeders? That is the line between a roll-up and an attribution.
        //
        // One feeder is not an inference at all: a PDU's total is its outlets' demand arriving by the only
        // route there is, and calling that a guess would label most of the diagram. Several feeders, with all
        // but one ruled out by Mode or by having gone silent, is different — the load is real but *which*
        // source supplied it is a claim about the hierarchy someone drew. That is the case that credited a PV
        // array with the whole house load after dark, and the case the switch governs.
        bool HasAlternatives(string to)
            => (incoming.TryGetValue(to, out var fs) ? fs.Count : 0) > 1;

        List<string> Absorbers(string to)
        {
            // Switched off: an attribution among alternatives is not made, and the node reads "no data"
            // instead. Roll-ups are untouched — turning off inference must not blank out the PDU totals.
            if (HasAlternatives(to) && !flow.InferFromConservation) return new List<string>();

            var feeders = incoming.TryGetValue(to, out var fs) ? fs : new List<string>();
            var unmeasured = feeders.Where(f => !leaf.ContainsKey(f) && !Inert(Mode(f)) && !Unavailable(f)).ToList();
            var residual = unmeasured.Where(f => Mode(f) == "residual").ToList();
            if (residual.Count > 0) return residual;
            return unmeasured.Count == 1 ? unmeasured : new List<string>();
        }

        // Is the flow along this link determined by measurements at all? False when several unmeasured
        // feeders compete to supply the same node — the link exists, but its share is unknowable, and it
        // must be shown as "no data" rather than as zero flow.
        bool Knowable(string from, string to)
        {
            // An intensive metric — voltage, frequency, power factor, state of charge, temperature — does
            // not flow, so no link carries a determinable amount of it. Saying so here makes every link
            // "no data" (a hairline) and, because ValueOf only aggregates *known* links, leaves each node
            // showing the reading it actually has and nothing where it has none. Without this the roll-up
            // summed them: three 120 V outlets reported a 360 V PDU, a figure true nowhere in the system.
            if (!FlowUnits.IsAdditive(metric)) return false;

            if (leaf.ContainsKey(from)) return true;         // a measured producer supplies a real figure
            if (Inert(Mode(from))) return true;              // 'none'/'static': deliberately contributes nothing

            // A feeder whose own source has stopped reporting carries an unknowable amount — not zero. Its
            // link must draw as "no data" so the failure is visible, rather than as a confident hairline.
            if (Unavailable(from)) return false;

            var feeders = incoming.TryGetValue(to, out var fs) ? fs : new List<string>();
            var unmeasured = feeders.Where(f => !leaf.ContainsKey(f) && !Inert(Mode(f)) && !Unavailable(f)).ToList();

            // A designated residual is told what it carries, so its own flow is determined. Its unmeasured
            // siblings are not: "the residual takes the remainder" says nothing about how much solar was
            // generating, so reporting 0 W for them would be a claim we can't support either.
            if (unmeasured.Any(f => Mode(f) == "residual")) return Mode(from) == "residual";

            // One unmeasured path is determined by conservation. Several is a real unknown.
            // With inference off we decline to pick between alternatives, but a plain roll-up still stands.
            if (HasAlternatives(to) && !flow.InferFromConservation) return false;
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
            var share = remainder / absorbers.Count;
            // Only an attribution gets the label. Where this feeder was the only route, the figure is the
            // downstream measurement arriving intact — a roll-up, and marking it inferred would cry wolf.
            if (share > 0 && HasAlternatives(to)) inferred.Add(from);
            return share;
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

                // A known-but-zero link is normally left off the diagram (an idle outlet, or a pure source
                // generating nothing — solar at night correctly drops out). But when the zero sits on a link
                // the user wired *out of a node that itself has incoming flow*, dropping it would detach the
                // whole chain below a mid-chain node that happens to read 0 W (e.g. an inverter whose "load"
                // register is 0 while its PV feeds straight through to the grid). Keep those, so the wired
                // topology always renders — the zero just draws as a hairline — while a zero-producing source
                // still drops as before.
                var passThroughZero = Wired(from, to) && incoming.TryGetValue(from, out var upstream) && upstream.Count > 0;

                // The same reasoning one step earlier, for the link *into* an inert ('none', or valueless
                // 'static') node that sits mid-chain. Such a node contributes nothing by design, so its links
                // carry zero forever; dropping the inbound one strands it — with no feeders left it lays out
                // as a root in column 0 rather than between the two nodes it was deliberately wired between.
                // Only mid-chain: an inert node used as a pure *source* has nothing to give and nothing
                // feeding it, and still drops out (Build_NoneNode_ContributesNothing… pins that).
                var midChainInert = Inert(Mode(to)) && outgoing.TryGetValue(to, out var below) && below.Count > 0;

                if (known && value <= 0 && !passThroughZero && !midChainInert) continue;

                links.Add(new FlowLink(from, to, value, known));
            }

        // The return lane: a battery being charged, a grid being exported to.
        //
        // A battery and a grid connection carry power both ways, but a Sankey is a DAG — a two-way edge
        // cannot be laid out, and a single signed value cannot be drawn at all (which is why a negative
        // reading is clamped above). So the two directions become two things on the diagram: the node
        // keeps the supply direction and stays to the LEFT of what it feeds, and its draw direction becomes
        // a sink to the RIGHT of that same hub. Charging then reads as the inverter feeding the battery,
        // which is what is physically happening.
        //
        // Both quantities are already measured and already separate: a Direction: split source fans one
        // signed reading into `realpower` and `realpower#in` (see FlowMetricKey), and the MQTT and HA
        // exports have consumed the #in side for a while. The graph was the last consumer ignoring it, so
        // a charging battery simply vanished from the picture instead of changing sides.
        //
        // A terminal sink by construction — no outgoing links — so it cannot close a cycle however the
        // rest is wired.
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
                links.Add(new FlowLink(hub, sinkId, drawn, true));
                wired.Add(hub); wired.Add(sinkId);
            }
        }

        // Name the load nobody is metering, instead of drawing it as a blank slab.
        //
        // A node's bar is as tall as its throughput, but only its links carry flow. A panel passing 8299 W
        // whose metered children draw 547 W therefore renders as an enormous bar with a few hairlines
        // leaving it and ~7.7 kW of unexplained height. That reads as a broken chart, when the actual
        // finding — most of the load downstream of this panel is not metered — is worth knowing and is
        // arithmetic on measurements already trusted.
        //
        // Not a fabricated reading: the difference is inflow minus what the children account for, and the
        // energy demonstrably went somewhere. What would be fabrication is attributing it to a device, so
        // it gets its own 'unmeasured' kind and its own node rather than being folded into a sibling.
        //
        // Only where the node already has outgoing links (a terminal leaf's reading IS its consumption, so
        // there is no gap to explain) and only above a 2% floor, to keep rounding noise off the diagram.
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
        // only has outflow, a leaf only inflow). No measurement and no known link means genuinely unknown —
        // reported as null rather than 0, so nothing downstream can mistake "we don't know" for "it's zero".
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
        // has no inflow and a terminal leaf no outflow, and neither is a contradiction.
        //
        // ValueOf reports the larger side, because a Sankey has to lay out *something* and a bar shorter than
        // the links leaving it is unreadable. But reporting it alone is how an 11x disagreement passed for a
        // measurement: the panel drew at full height, the ribbon feeding it drew as a sliver, and nothing said
        // which of the two numbers to believe. Carrying the gap explicitly lets the diagram say so.
        double? ImbalanceOf(string id)
        {
            var (inflow, outflow, anyIn, anyOut) = Sides(id);
            if (!anyIn || !anyOut) return null;

            // A node whose own reading is smaller than what passes through it is NOT contradicted. An
            // inverter bound to `load_power` reports its AC-load leg while also charging a battery: 8,725 W
            // of PV in, 3,933 W to the panel and 4,589 W into the battery — every watt accounted for. This
            // used to compare the reading against throughput and call the difference unaccounted, so the
            // diagram announced that "more than a quarter of what passes through is unaccounted for" about a
            // node that balanced to within its conversion loss. What is smaller than the throughput is the
            // sensor's coverage, and that is reported separately (see ThroughputOf) rather than as a fault.
            var gap = outflow - inflow;
            // Rounding noise and honest conversion loss are not contradictions; 2% matches the floor the
            // unmeasured-load synthesis above already uses for the same reason.
            return gap > 1 && gap > inflow * 0.02 ? gap : null;
        }

        // What actually passes through a measured node, when its own reading covers less than that.
        //
        // The reading is not wrong and the flows are not contradicted — the sensor is on one leg. Carried so
        // the diagram can say "3,933 W measured of 8,725 W passing through" instead of drawing a bar a third
        // the width of its own ribbons with no explanation, which is what made this look like a fault.
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
        // and so an inferred figure can never be mistaken for a metered one.
        string DerivationOf(string id)
        {
            if (leaf.ContainsKey(id)) return FlowDerivation.Measured;
            if (ValueOf(id) is null) return FlowDerivation.Unknown;
            // A node that absorbed a remainder is inferred even if it also sums children — the back-fill is
            // the part that isn't measured, and that is what the label has to warn about.
            return inferred.Contains(id) ? FlowDerivation.Inferred : FlowDerivation.Summed;
        }

        // Every node the user declared, plus every auto (pdu/outlet) node that reported a measurement —
        // whether or not a value could be determined for it. A configured node that silently disappears is
        // its own kind of inaccuracy: it reads as "my config is broken" rather than "nothing measures this".
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
