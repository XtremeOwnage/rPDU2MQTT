namespace rPDU2MQTT.Grains.Abstractions.Pdu;

/// <summary>
/// A OneView group as its own grain (key <c>instanceId|groupKey</c>) — the single cluster-wide owner of that
/// group's control. An action fans out to the group's member outlets exactly once, regardless of how many
/// processes received the command.
/// <para>
/// A group belongs to one PDU, and two PDUs may each expose a group with the same name. Keying by group name
/// alone made those one actor, so whichever PDU polled last decided where the action went. The instance is
/// part of the identity instead: same name on two PDUs is two groups, because that's what it is.
/// </para>
/// </summary>
public interface IOneViewGroupGrain : IGrainWithStringKey
{
    /// <summary>Apply an action to every member outlet of this group. Returns a human-readable result.</summary>
    Task<string> Control(string action);

    /// <summary>The grain key for a group on a PDU instance.</summary>
    static string KeyFor(string instanceId, string groupKey) => $"{instanceId}|{groupKey}";
}
