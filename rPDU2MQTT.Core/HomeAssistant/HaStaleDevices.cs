namespace rPDU2MQTT.Core.HomeAssistant;

/// <summary>One device in Home Assistant's registry, reduced to what deciding its fate needs.</summary>
/// <param name="Id">HA's internal device id — what the delete call takes.</param>
/// <param name="Name">What it is called in the UI, for showing the operator before anything is removed.</param>
/// <param name="Identifiers">The integration-supplied identifiers; ours carry a known prefix.</param>
/// <param name="EntityCount">How many entities HA still has attached to it.</param>
/// <param name="ConfigEntryIds">The config entries it belongs to; removal is per entry.</param>
public sealed record HaDevice(
    string Id, string? Name, IReadOnlyList<string> Identifiers, int EntityCount, IReadOnlyList<string> ConfigEntryIds);

/// <summary>
/// Which Home Assistant devices are ours and no longer backed by anything.
///
/// <para>
/// Clearing a retained discovery config removes a device only if Home Assistant is listening when the
/// retraction arrives. It usually is — but a config removed while HA was down, or one whose id scheme
/// changed between versions, leaves a device that nothing can ever reach again over MQTT: there is no
/// config left to retract, and HA does not drop a device merely because nothing mentions it any more.
/// Seen here: 39 of them, from a build that named outlets <c>rack_pdu_1</c> where the current one says
/// <c>pdu_1</c>.
/// </para>
/// <para>
/// So this is the one cleanup that cannot go through the broker. It talks to Home Assistant directly and
/// deletes the registry entry.
/// </para>
/// </summary>
public static class HaStaleDevices
{
    /// <summary>
    /// The devices safe to delete: ours by identifier prefix, and holding <b>no entities at all</b>.
    ///
    /// <para>
    /// The zero-entity rule is what makes this safe rather than clever. A device that still has entities is
    /// live — its discovery is current, or HA is mid-reload — and deleting it would take working sensors out
    /// of someone's dashboards and history. A device with none is already inert in the UI: it shows a name, a
    /// model, and nothing that reads anything. Only those go.
    /// </para>
    /// <para>
    /// Ownership is a prefix on the identifier, never a substring: another integration mirroring our naming
    /// (<c>solar_rPDU2MQTT_copy</c>) is not ours to delete, and nothing here could put it back.
    /// </para>
    /// </summary>
    public static IReadOnlyList<HaDevice> Stale(IEnumerable<HaDevice> devices)
        => (devices ?? Enumerable.Empty<HaDevice>())
            .Where(d => d.EntityCount == 0
                     && d.ConfigEntryIds.Count > 0
                     && d.Identifiers.Any(i => HaDiscoveryTopics.OwnedIdPrefixes.Any(
                            p => (i ?? "").StartsWith(p, StringComparison.OrdinalIgnoreCase))))
            .ToList();
}
