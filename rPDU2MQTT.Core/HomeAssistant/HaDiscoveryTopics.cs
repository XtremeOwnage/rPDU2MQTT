namespace rPDU2MQTT.Core.HomeAssistant;

/// <summary>
/// Which retained Home Assistant discovery topics on the broker belong to this project.
///
/// <para>
/// "Clear discovery" used to mean "clear what this process published since it started" — a set held in
/// memory by one service. That is not what anyone reading the button expects, and it cannot be: it has no
/// knowledge of topics published by a previous version under different ids, by the energy-flow exporter
/// (a separate service keeping its own set), or by any configuration that has since changed. Everything
/// outside that set survived the clear and stayed in Home Assistant forever, because the only thing that
/// could ever have removed it had already forgotten it existed.
/// </para>
/// <para>
/// The set of things to clear therefore has to come from the <b>broker</b>, not from memory: whatever is
/// actually retained under the discovery prefix, filtered to the ids this project issues.
/// </para>
/// </summary>
public static class HaDiscoveryTopics
{
    /// <summary>
    /// Device/entity id prefixes this project issues. Everything it publishes is named with one of these:
    /// <c>rPDU2MQTT_</c> for PDU-derived devices and <c>energyflow_</c> for energy-hierarchy tiers.
    /// </summary>
    public static readonly string[] OwnedIdPrefixes = ["rPDU2MQTT_", "energyflow_"];

    /// <summary>
    /// Every retained discovery topic under <paramref name="discoveryPrefix"/> whose id this project owns.
    ///
    /// <para>
    /// Matches both discovery layouts Home Assistant accepts — <c>&lt;prefix&gt;/&lt;component&gt;/&lt;id&gt;/config</c>
    /// and the node-scoped <c>&lt;prefix&gt;/&lt;component&gt;/&lt;node&gt;/&lt;id&gt;/config</c> — so a config
    /// written by an older build in the per-entity format is found as readily as today's device-scoped one.
    /// </para>
    /// <para>
    /// Ownership is decided by the id prefix and nothing else. Another integration's discovery must never be
    /// touched: clearing it deletes someone's devices out of Home Assistant, and nothing here would put them
    /// back. A blank discovery prefix matches nothing rather than everything, which is the way round that
    /// fails safely.
    /// </para>
    /// </summary>
    public static IReadOnlyList<string> Owned(IEnumerable<string> retainedTopics, string? discoveryPrefix)
    {
        var root = (discoveryPrefix ?? "").Trim().Trim('/');
        if (root.Length == 0) return Array.Empty<string>();

        var found = new List<string>();
        foreach (var topic in retainedTopics ?? Enumerable.Empty<string>())
        {
            if (string.IsNullOrWhiteSpace(topic)) continue;
            var parts = topic.Split('/');

            // <root>/<component>/<id>/config, optionally with a node id before the object id.
            if (parts.Length is not (4 or 5)) continue;
            if (!string.Equals(parts[0], root, StringComparison.OrdinalIgnoreCase)) continue;
            if (!string.Equals(parts[^1], "config", StringComparison.OrdinalIgnoreCase)) continue;

            var id = parts[^2];
            if (OwnedIdPrefixes.Any(p => id.StartsWith(p, StringComparison.OrdinalIgnoreCase)))
                found.Add(topic);
        }
        return found;
    }
}
