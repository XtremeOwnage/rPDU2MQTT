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

        // Custom parent links (parent feeds child) — only when both endpoints are known nodes.
        foreach (var (child, parent) in flow.Parents)
            if (!string.IsNullOrEmpty(child) && !string.IsNullOrEmpty(parent) && label.ContainsKey(child) && label.ContainsKey(parent))
                AddEdge(parent, child);

        // Each node's total = sum of leaf (outlet) measurements reachable downstream (memoized, cycle-guarded).
        var memo = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);
        double DownstreamTotal(string id, HashSet<string> path)
        {
            if (memo.TryGetValue(id, out var cached)) return cached;
            if (!path.Add(id)) return 0;   // cycle guard
            double sum = outgoing.TryGetValue(id, out var kids) && kids.Count > 0
                ? kids.Sum(k => DownstreamTotal(k, path))
                : (leaf.TryGetValue(id, out var lv) ? lv : 0);
            path.Remove(id);
            memo[id] = sum;
            return sum;
        }

        // Emit links (value = downstream total of the target); collect the nodes that actually carry flow.
        var links = new List<FlowLink>();
        var used = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var (from, kids) in outgoing)
            foreach (var to in kids)
            {
                var value = DownstreamTotal(to, new HashSet<string>(StringComparer.OrdinalIgnoreCase));
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
