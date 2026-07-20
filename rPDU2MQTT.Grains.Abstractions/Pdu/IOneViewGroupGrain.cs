namespace rPDU2MQTT.Grains.Abstractions.Pdu;

/// <summary>
/// A OneView group as its own grain (key = group key) — the single cluster-wide owner of group control. A
/// group action (on/off/reboot) fans out to the group's member outlets exactly once, regardless of how many
/// processes received the command.
/// </summary>
public interface IOneViewGroupGrain : IGrainWithStringKey
{
    /// <summary>Apply an action to every member outlet of this group. Returns a human-readable result.</summary>
    Task<string> Control(string action);
}
