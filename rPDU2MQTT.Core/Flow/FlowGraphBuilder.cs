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

    public static FlowGraph Build(PduData data, EnergyFlowConfig? flow, string metric = DefaultMetric)
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

        // Custom upstream nodes (#129). A node with a directly-known Value is a leaf source (the seam
        // where external sensors — CT clamps, emoncms, Tigo, inverter ports — will bind their live value).
        foreach (var n in flow.Nodes)
            if (!string.IsNullOrEmpty(n.Id))
            {
                label[n.Id] = string.IsNullOrEmpty(n.Label) ? n.Id : n.Label;
                if (!kind.ContainsKey(n.Id)) kind[n.Id] = "node";
                if (n.Value is > 0) leaf[n.Id] = n.Value.Value;
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

        // How many feeders does each node have? A node's demand is split equally among them so a node
        // reachable by several paths (e.g. a panel fed both directly and via a sub-panel) isn't counted
        // multiple times — otherwise the inflow inflates and the Sankey can't balance.
        var inCount = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        foreach (var (_, kids) in outgoing)
            foreach (var to in kids)
                inCount[to] = inCount.GetValueOrDefault(to) + 1;

        // Need(id): power this node must receive = its known value (outlet sink or producer), else the sum
        // of the flows on its outgoing links. EdgeFlow: a producer supplies its measured generation; a
        // demand link carries its share (target demand ÷ number of feeders). Memoized + cycle-guarded.
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
        double EdgeFlow(string from, string to, HashSet<string> path)
            => leaf.TryGetValue(from, out var produced)
                ? produced
                : Need(to, path) / Math.Max(1, inCount.GetValueOrDefault(to));

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
