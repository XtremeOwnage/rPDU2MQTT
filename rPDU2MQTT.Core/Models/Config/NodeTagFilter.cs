using System.ComponentModel;

namespace rPDU2MQTT.Models.Config;

/// <summary>
/// Which energy-flow nodes a destination receives, chosen by their tags (#342).
///
/// <para>
/// Empty means everything, so an existing install is unaffected until something is entered here. The
/// filter decides what is <em>sent</em>; it never changes a value. A node excluded from Prometheus still
/// reports normally on the diagram, still contributes to whatever aggregates from it, and still goes to
/// every other destination.
/// </para>
/// <para>
/// Exclude wins over include. Tag a handful of nodes "noisy", exclude that one tag, and the rule reads the
/// same whether or not the include list is also in use — the alternative (include winning) makes a node
/// that matches both silently reappear, which is the opposite of what someone typing an exclusion expects.
/// </para>
/// </summary>
public class NodeTagFilter
{
    [TagChoices]
    [Description("Only send nodes carrying at least one of these tags. Empty sends every node.")]
    public List<string> Include { get; set; } = new();

    [TagChoices]
    [Description("Never send nodes carrying any of these tags. Takes precedence over Include.")]
    public List<string> Exclude { get; set; } = new();

    /// <summary>Whether this filter is doing anything at all.</summary>
    public bool IsEmpty => Include.Count == 0 && Exclude.Count == 0;

    /// <summary>
    /// Whether a node with <paramref name="tags"/> may be sent.
    /// </summary>
    /// <remarks>
    /// An untagged node passes an empty include list and fails a populated one. That follows from what
    /// "only send nodes tagged X" means, and it is the reading that cannot lose data by surprise: naming a
    /// tag is a deliberate narrowing, whereas treating untagged nodes as always-included would make the
    /// include list do nothing on the install where nothing is tagged yet.
    /// </remarks>
    public bool Allows(IReadOnlyList<string>? tags)
    {
        if (IsEmpty) return true;

        var has = tags ?? [];
        if (Exclude.Count > 0 && Exclude.Any(x => has.Any(t => string.Equals(t, x?.Trim(), StringComparison.OrdinalIgnoreCase))))
            return false;

        return Include.Count == 0
            || Include.Any(i => has.Any(t => string.Equals(t, i?.Trim(), StringComparison.OrdinalIgnoreCase)));
    }
}
