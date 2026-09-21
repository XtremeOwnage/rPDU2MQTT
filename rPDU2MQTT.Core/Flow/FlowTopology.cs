using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Models.PDU;

namespace rPDU2MQTT.Core.Flow;

/// <summary>
/// Who feeds whom, from the configuration and the snapshot alone — no readings, so a link that carries nothing
/// right now is still a link (#461).
/// </summary>
public sealed class FlowTopology
{
    private static readonly StringComparer Ids = StringComparer.OrdinalIgnoreCase;
    private readonly Dictionary<string, List<string>> children = new(Ids);
    private readonly Dictionary<string, List<string>> feeders = new(Ids);
    private readonly HashSet<string> nodes = new(Ids);

    public IReadOnlyCollection<string> Nodes => nodes;

    public IReadOnlyList<string> Children(string id) => children.TryGetValue(id, out var c) ? c : [];

    public IReadOnlyList<string> Feeders(string id) => feeders.TryGetValue(id, out var f) ? f : [];

    public static FlowTopology For(PduData? data, EnergyFlowConfig? flow)
    {
        flow ??= new EnergyFlowConfig();
        var t = new FlowTopology();
        foreach (var n in flow.Nodes) if (!string.IsNullOrWhiteSpace(n.Id)) t.nodes.Add(n.Id);

        var explicitlyFed = new HashSet<string>(flow.Links.Select(l => l.To).Concat(flow.Parents.Keys).Where(x => !string.IsNullOrEmpty(x)), Ids);
        foreach (var device in data?.Devices ?? new())
        {
            var pdu = FlowNodeId.ForPdu(device.Entity_Name);
            t.nodes.Add(pdu);
            foreach (var outlet in device.Outlets)
            {
                var id = FlowNodeId.ForOutlet(device.Entity_Name, outlet.Key);
                t.nodes.Add(id);
                if (!explicitlyFed.Contains(id)) t.Link(pdu, id);
            }
        }

        foreach (var l in FlowGraphBuilder.NestGroupMembers(flow))
            if (!string.IsNullOrWhiteSpace(l.From) && !string.IsNullOrWhiteSpace(l.To)) t.Link(l.From, l.To);
        foreach (var (child, parent) in flow.Parents)
            if (!string.IsNullOrWhiteSpace(child) && !string.IsNullOrWhiteSpace(parent)) t.Link(parent, child);
        return t;
    }

    /// <summary>A topology from explicit links, for callers that already hold them.</summary>
    public static FlowTopology Of(IEnumerable<(string From, string To)> links, IEnumerable<string>? extraNodes = null)
    {
        var t = new FlowTopology();
        foreach (var n in extraNodes ?? []) t.nodes.Add(n);
        foreach (var (from, to) in links) t.Link(from, to);
        return t;
    }

    private void Link(string from, string to)
    {
        if (Ids.Equals(from, to) || Reaches(to, from)) return;
        nodes.Add(from);
        nodes.Add(to);
        if (!children.TryGetValue(from, out var c)) children[from] = c = new();
        if (!c.Contains(to, Ids)) c.Add(to);
        if (!feeders.TryGetValue(to, out var f)) feeders[to] = f = new();
        if (!f.Contains(from, Ids)) f.Add(from);
    }

    /// <summary>Can <paramref name="a"/> reach <paramref name="b"/> following the links already added?</summary>
    public bool Reaches(string a, string b)
    {
        var stack = new Stack<string>([a]);
        var seen = new HashSet<string>(Ids);
        while (stack.Count > 0)
        {
            var x = stack.Pop();
            if (Ids.Equals(x, b)) return true;
            if (!seen.Add(x)) continue;
            foreach (var k in Children(x)) stack.Push(k);
        }
        return false;
    }

    /// <summary>Is <paramref name="node"/> somewhere beneath <paramref name="ancestor"/>?</summary>
    public bool Beneath(string node, string ancestor) => !Ids.Equals(node, ancestor) && Reaches(ancestor, node);
}
