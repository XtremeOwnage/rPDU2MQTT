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
    // Devices supplied by plugins, which own their own writes — the outlet grain knows nothing about them.
    private readonly Core.Integrations.IntegrationRegistry? integrations;
    private readonly Config? cfg;
    private readonly Core.Integrations.ISingleOwnerLease? lease;

    public OutletGrainControl(IGrainFactory grains, PduInstanceRegistry registry,
        Core.Integrations.IntegrationRegistry? integrations = null, Config? cfg = null,
        Core.Integrations.ISingleOwnerLease? lease = null)
    {
        this.grains = grains;
        this.registry = registry;
        this.integrations = integrations;
        this.cfg = cfg;
        this.lease = lease;
    }

    public async Task<string> Control(string deviceId, int outletIndex, string action, CancellationToken cancellationToken = default)
    {
        // A plugin-supplied device owns its own writes: the outlet grain is built around the Vertiv API and
        // has no way to reach someone else's hardware. Checked first, and only ever matching a device this
        // build actually loaded, so nothing changes for a PDU.
        if (PluginFor(deviceId) is var (integration, control) && control is not null && control.Supports(action))
        {
            var result = "";
            await (lease ?? new Core.Integrations.SoleOwnerLease()).RunIfOwnerAsync(
                $"device:{deviceId}",
                async ct => result = await control.ControlOutletAsync(cfg!, deviceId, outletIndex, action, ct),
                cancellationToken);
            return result;
        }

        return await grains.GetGrain<IOutletGrain>(IOutletGrain.KeyFor(deviceId, outletIndex)).Control(action);
    }

    /// <summary>The plugin that owns this device id, or (null, null) when a built-in PDU does.</summary>
    private (Core.Integrations.IIntegration? Integration, Core.Integrations.IDeviceControlPlugin? Control) PluginFor(string deviceId)
    {
        if (integrations is null || cfg is null) return (null, null);
        foreach (var i in integrations.All)
            if (i is Core.Integrations.IDeviceSourcePlugin device
                && string.Equals(device.InstanceId, deviceId, StringComparison.OrdinalIgnoreCase)
                && i is Core.Integrations.IDeviceControlPlugin control)
                return (i, control);
        return (null, null);
    }

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
