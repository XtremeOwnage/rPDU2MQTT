using rPDU2MQTT.Models.Config;

namespace rPDU2MQTT.Core.Flow;

/// <summary>A metered device on a circuit, and what it reads (#465).</summary>
public sealed record CircuitDevice(string Node, double? Value);

/// <summary>Whether a circuit's unmetered remainder is known (#465).</summary>
public enum RemainderState
{
    /// <summary>Nothing metered is recorded on the circuit, so there is no remainder to speak of.</summary>
    NoDevices,
    /// <summary>The circuit and every device on it read, so the remainder is their difference.</summary>
    Known,
    /// <summary>The circuit or a device on it has no reading. Never assumed 0.</summary>
    Unknown,
}

/// <summary>A circuit: its breaker, what it reads, what is metered on it and what is placed on it (#464, #465).</summary>
public sealed record CircuitReport(
    BreakerChain Chain,
    string Ref,
    string? Node,
    double? Power,
    PowerGap Gap,
    IReadOnlyList<CircuitDevice> Devices,
    double? Remainder,
    RemainderState State,
    bool Exceeded,
    IReadOnlyList<PlacementConfig> Placements,
    IReadOnlyList<string> Rooms);

/// <summary>Circuits as the floor plan sees them: a breaker, referred to as "panel/number".</summary>
public static class Circuits
{
    private static readonly StringComparer Ids = StringComparer.OrdinalIgnoreCase;

    /// <summary>How much a device may read over its circuit before it is flagged: CTs and plugs disagree a little.</summary>
    public static double Tolerance(double circuit) => Math.Max(5, Math.Abs(circuit) * 0.03);

    public static string Ref(string panel, string number) => $"{panel}/{number}";

    /// <summary>A "panel/number" reference split in two, or null when it is not one.</summary>
    public static (string Panel, string Breaker)? Parse(string? circuit)
    {
        if (string.IsNullOrWhiteSpace(circuit)) return null;
        var at = circuit.IndexOf('/');
        if (at <= 0 || at == circuit.Length - 1) return null;
        return (circuit[..at].Trim(), circuit[(at + 1)..].Trim());
    }

    /// <summary>The breaker a reference names, or null when no such breaker is in the directory.</summary>
    public static BreakerChain? Find(PanelMap map, string? circuit) =>
        Parse(circuit) is { } p ? map.Breaker(p.Panel, p.Breaker) : null;

    public static string RefOf(BreakerChain chain) => Ref(chain.Panel.Id, chain.Breaker.Number);

    /// <summary>The node that is this circuit: the breaker's own, else the one channel measuring it. Null when two legs are on two channels.</summary>
    public static string? NodeOf(BreakerChain chain)
    {
        if (!string.IsNullOrWhiteSpace(chain.Breaker.Node)) return chain.Breaker.Node.Trim();
        var legs = chain.Legs.Any(l => l.Clamp?.Whole == true) ? chain.Legs.Where(l => l.Clamp?.Whole == true).ToList() : chain.Legs;
        var channels = legs.Select(l => l.Channel).ToList();
        if (channels.Count == 0 || channels.Any(c => c is null)) return null;
        var distinct = channels.Distinct(Ids).ToList();
        return distinct.Count == 1 ? distinct[0] : null;
    }

    /// <summary>
    /// Every circuit with what reads on it. A device beneath another device on the same circuit is not counted twice,
    /// and the remainder is never clamped: a device reading more than its circuit is flagged instead.
    /// </summary>
    public static IReadOnlyList<CircuitReport> Report(EnergyFlowConfig flow, IFlowValueSource? live, Func<string, double?> valueOf,
        FlowTopology? topology = null, string metric = FlowGraphBuilder.DefaultMetric)
    {
        var map = PanelMap.For(flow);
        var placements = flow.Placements ?? new();
        var reports = new List<CircuitReport>();
        foreach (var chain in map.Chains)
        {
            var reference = RefOf(chain);
            bool Mine(string? c) => Parse(c) is { } p && Ids.Equals(p.Panel, chain.Panel.Id) && Ids.Equals(p.Breaker, chain.Breaker.Number);

            var node = NodeOf(chain);
            var power = PanelMap.Power(chain, live, metric, out var gap);
            if (power is null && node is not null && valueOf(node) is { } nodeValue) { power = nodeValue; gap = PowerGap.None; }

            var deviceIds = flow.Nodes.Where(n => Mine(n.Circuit) && !string.IsNullOrWhiteSpace(n.Id)).Select(n => n.Id)
                .Concat(placements.Where(p => Mine(p.Circuit) && !string.IsNullOrWhiteSpace(p.Node)).Select(p => p.Node))
                .Where(id => node is null || !Ids.Equals(id, node))
                .Distinct(Ids).ToList();
            if (topology is not null)
                deviceIds = deviceIds.Where(d => !deviceIds.Any(other => topology.Beneath(d, other))).ToList();
            var devices = deviceIds.Select(d => new CircuitDevice(d, valueOf(d))).ToList();

            double? remainder = null;
            var state = RemainderState.NoDevices;
            if (devices.Count > 0)
            {
                state = power is not null && devices.All(d => d.Value is not null) ? RemainderState.Known : RemainderState.Unknown;
                if (state == RemainderState.Known) remainder = power!.Value - devices.Sum(d => d.Value!.Value);
            }
            // Flagged as soon as what is known already reads over the circuit, even with a device still unread.
            var known = devices.Where(d => d.Value is not null).Sum(d => d.Value!.Value);
            var exceeded = power is { } p && devices.Any(d => d.Value is not null) && known - p > Tolerance(p);

            reports.Add(new CircuitReport(chain, reference, node, power, gap, devices, remainder, state, exceeded,
                placements.Where(p => Mine(p.Circuit)).ToList(),
                (chain.Breaker.Rooms ?? new()).Where(x => !string.IsNullOrWhiteSpace(x)).ToList()));
        }
        return reports;
    }
}
