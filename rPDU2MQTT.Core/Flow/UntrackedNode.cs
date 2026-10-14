using rPDU2MQTT.Models.Config;

namespace rPDU2MQTT.Core.Flow;

/// <summary>
/// The node a parent gets for what it measures beyond its children, when <see cref="EnergyFlowNode.CreateUntracked"/>
/// asks for one. One per parent, so there is never a spare to split between two of them, and it exists only
/// beneath a node that measures something.
/// </summary>
public static class UntrackedNode
{
    public const string Mode = "untracked";

    private const string Prefix = "untracked:";

    /// <summary>The id the untracked node under <paramref name="parentId"/> gets. Stable, so its history and exports carry on.</summary>
    public static string IdFor(string parentId) => Prefix + parentId;

    /// <summary>The label it gets unless a node entry with its id names it.</summary>
    public static string LabelFor(string parentLabel) => $"{parentLabel}: Untracked";

    /// <summary>On by default where unmetered load is what a reader wants to see: panels, inverters, the grid.</summary>
    public static bool DefaultFor(string? kind)
        => (kind ?? "").Trim().ToLowerInvariant() is "panel" or "inverter" or "grid";

    /// <summary>Does this node ask for an untracked node beneath it?</summary>
    public static bool Wanted(EnergyFlowNode node) => node.CreateUntracked == true;

    /// <summary>
    /// Turn it on for every panel, inverter and grid node that has not said either way, as a loaded config is
    /// read. Settled in the config rather than at each read, so the editor shows what is in effect and an
    /// unticked box stays unticked.
    /// </summary>
    public static void ApplyDefaults(EnergyFlowConfig flow)
    {
        foreach (var n in flow.Nodes)
            if (n.CreateUntracked is null && DefaultFor(n.Kind) && !Is(n)) n.CreateUntracked = true;
    }

    /// <summary>A node set to be the untracked slice of its parent, by hand or by id.</summary>
    public static bool Is(EnergyFlowNode node)
        => string.Equals((node.Mode ?? "").Trim(), Mode, StringComparison.OrdinalIgnoreCase)
           || node.Id.StartsWith(Prefix, StringComparison.OrdinalIgnoreCase);
}
