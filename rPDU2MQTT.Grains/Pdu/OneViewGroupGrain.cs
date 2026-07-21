using rPDU2MQTT.Grains.Abstractions.Pdu;

namespace rPDU2MQTT.Grains.Pdu;

/// <summary>
/// A OneView group on one PDU (key <c>instanceId|groupKey</c>). Single cluster-wide owner of that group's
/// control: an action fans out to its member outlets exactly once. Member resolution + fan-out belong to the
/// PDU (which reads the OneView host→group mapping), so this grain asks its parent to do it — and knows
/// which parent because the instance is half of its own key.
/// </summary>
public sealed class OneViewGroupGrain : PduChildGrain, IOneViewGroupGrain
{
    private string groupKey = "";

    public override Task OnActivateAsync(CancellationToken cancellationToken)
    {
        var key = this.GetPrimaryKeyString();
        var sep = key.IndexOf('|');   // instance ids can't contain '|'; a group name might
        if (sep > 0)
        {
            BindOwner(key[..sep]);
            groupKey = key[(sep + 1)..];
        }
        else groupKey = key;          // legacy key (no instance): its parent is unknown, so it writes nowhere

        return base.OnActivateAsync(cancellationToken);
    }

    public async Task<string> Control(string action)
    {
        var act = action.Trim().ToLowerInvariant();
        if (act is not ("on" or "off" or "reboot")) return $"Unknown group action '{action}'.";

        // The group's own PDU performs the fan-out; this grain's job is that it happens exactly once.
        if (Parent is not { } pdu) return "No PDU available to control this group.";
        return await pdu.ControlGroup(groupKey, act);
    }
}
