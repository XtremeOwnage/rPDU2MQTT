using Microsoft.Extensions.DependencyInjection;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Grains.Abstractions.Pdu;

namespace rPDU2MQTT.Grains.Pdu;

/// <summary>
/// A OneView group (key = group key). Single cluster-wide owner of group control: an action fans out to the
/// group's member outlets exactly once. Member resolution + fan-out belong to the PDU (which reads the
/// OneView host→group mapping); the grain guarantees the single-owner property and, via
/// <see cref="Bind"/>, that the fan-out goes through the PDU the group is actually on — see
/// <see cref="PduOwner"/>.
/// </summary>
public sealed class OneViewGroupGrain : Grain, IOneViewGroupGrain
{
    private readonly IServiceProvider sp;
    private string groupKey = "";
    private string? instanceId;

    public OneViewGroupGrain(IServiceProvider sp) => this.sp = sp;

    public override Task OnActivateAsync(CancellationToken cancellationToken)
    {
        groupKey = this.GetPrimaryKeyString();
        return base.OnActivateAsync(cancellationToken);
    }

    public Task Bind(string id) { instanceId = id; return Task.CompletedTask; }

    public async Task<string> Control(string action)
    {
        var act = action.Trim().ToLowerInvariant();
        if (act is not ("on" or "off" or "reboot")) return $"Unknown group action '{action}'.";

        var pdu = PduOwner.Resolve(sp, instanceId);
        if (pdu is null) return "No PDU available to control this group.";

        var count = await pdu.ControlGroupAsync(groupKey, act, CancellationToken.None);
        return $"Group '{groupKey}' {act}: applied to {count} outlet(s).";
    }
}
