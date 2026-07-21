using Orleans;
using rPDU2MQTT.Abstractions.Pdu;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Grains.Abstractions.Pdu;

namespace rPDU2MQTT.Hosting;

/// <summary>
/// Routes outlet writes to the per-outlet <see cref="IOutletGrain"/> (single cluster-wide owner), so a
/// command received on any process actions the outlet exactly once. The Engine-side command subscriber
/// depends only on <see cref="IOutletControl"/>, not on Orleans.
/// </summary>
public sealed class OutletGrainControl : IOutletControl
{
    private readonly IGrainFactory grains;
    private readonly PduInstanceRegistry registry;

    public OutletGrainControl(IGrainFactory grains, PduInstanceRegistry registry)
    {
        this.grains = grains;
        this.registry = registry;
    }

    public Task<string> Control(string deviceId, int outletIndex, string action, CancellationToken cancellationToken = default)
        => grains.GetGrain<IOutletGrain>(IOutletGrain.KeyFor(deviceId, outletIndex)).Control(action);

    public Task<string> SetOutletConfig(string deviceId, int outletIndex, string field, string payload, bool isDelay, CancellationToken cancellationToken = default)
        => grains.GetGrain<IOutletGrain>(IOutletGrain.KeyFor(deviceId, outletIndex)).SetConfig(field, payload, isDelay);

    /// <summary>
    /// A group command names a group, not a PDU — the command topic has no instance segment — so this asks
    /// each PDU which groups it actually has and actions the ones that do. Outlets don't need this (a device
    /// id identifies its PDU), but group names are only unique within a PDU: two of them may legitimately
    /// have a "Rack 1", and a command addressed to that name means both.
    /// </summary>
    public async Task<string> ControlGroup(string groupKey, string action, CancellationToken cancellationToken = default)
    {
        var results = new List<string>();
        foreach (var instanceId in registry.All.Keys)
        {
            List<string> groups;
            try { groups = (await grains.GetGrain<IPduGrain>(instanceId).Children()).Groups ?? new(); }
            catch (Exception ex) { results.Add($"{instanceId}: {ex.Message}"); continue; }

            if (!groups.Contains(groupKey, StringComparer.OrdinalIgnoreCase)) continue;

            var grain = grains.GetGrain<IOneViewGroupGrain>(IOneViewGroupGrain.KeyFor(instanceId, groupKey));
            results.Add(await grain.Control(action));
        }

        return results.Count == 0
            ? $"No PDU reports a group '{groupKey}' (nothing polled yet, or the name doesn't exist)."
            : string.Join(" ", results);
    }
}
