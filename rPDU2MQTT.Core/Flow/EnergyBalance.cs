using rPDU2MQTT.Models.Config;

namespace rPDU2MQTT.Core.Flow;

/// <summary>
/// Which headline total — solar, grid, battery or home — a node counts toward, if any.
///
/// <para>
/// One rule for every page and export that shows the site's balance, so the Energy board, the Overview,
/// Trends and the Home Assistant Energy Dashboard cannot disagree about what "solar" is. Where
/// <see cref="EnergyFlowConfig.Balance"/> names the nodes, those are the totals and nothing else is.
/// Where it names none, a node counts by its kind — <c>load</c> as home — unless another node already holds
/// it, which is the rule the pages each applied (or forgot to) before (#491).
/// </para>
/// </summary>
public static class EnergyBalance
{
    public const string Solar = "solar";
    public const string Grid = "grid";
    public const string Battery = "battery";
    public const string Home = "home";

    public static readonly string[] Roles = [Solar, Grid, Battery, Home];

    /// <summary>Has the configuration said which nodes are the totals?</summary>
    public static bool IsConfigured(EnergyFlowConfig? flow)
        => flow?.Balance is { } b && (b.Solar.Count + b.Grid.Count + b.Battery.Count + b.Home.Count) > 0;

    /// <summary>The ids a role is made of, as configured.</summary>
    public static IReadOnlyList<string> Members(EnergyFlowConfig? flow, string role)
    {
        var b = flow?.Balance;
        if (b is null) return [];
        return role switch
        {
            Solar => b.Solar,
            Grid => b.Grid,
            Battery => b.Battery,
            Home => b.Home,
            _ => [],
        };
    }

    /// <summary>
    /// The total this node counts toward, or null. A return lane (<c>…#in</c>) counts toward the same total
    /// as its node — charge and export are the battery's and the grid's — and a remainder the builder
    /// invented counts toward nothing.
    /// </summary>
    /// <param name="within">The node that already holds this one, where the kind rule applies.</param>
    public static string? RoleOf(EnergyFlowConfig? flow, string id, string? kind, string? within)
    {
        if (string.IsNullOrWhiteSpace(id)) return null;
        if (id.EndsWith(FlowMetricKey.InSuffix, StringComparison.Ordinal)) id = id[..^FlowMetricKey.InSuffix.Length];
        if (id.Contains('#')) return null;

        if (IsConfigured(flow))
        {
            foreach (var role in Roles)
                if (Members(flow, role).Contains(id, StringComparer.OrdinalIgnoreCase)) return role;
            return null;
        }

        // Counted once: a string beneath its PV total, an appliance beneath its circuit.
        if (!string.IsNullOrEmpty(within)) return null;
        return kind?.ToLowerInvariant() switch
        {
            "solar" => Solar,
            "grid" => Grid,
            "battery" => Battery,
            "load" => Home,
            _ => null,
        };
    }
}
