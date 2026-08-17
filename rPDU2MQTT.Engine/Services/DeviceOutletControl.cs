using Microsoft.Extensions.Logging;
using rPDU2MQTT.Abstractions.Pdu;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core;
using rPDU2MQTT.Core.Integrations;

namespace rPDU2MQTT.Services;

/// <summary>
/// Every write to a device — an outlet action, an outlet config field, a OneView group action.
///
/// <para>
/// Ownership is the whole point of this class: a write goes to the PDU the device was actually polled from,
/// never to whichever PDU happens to be primary, and it runs once (the lease) rather than once per caller.
/// Which PDU that is comes from the snapshot cache — the same poll that reported the device.
/// </para>
/// <para>
/// When nothing has polled the device, the honest answer is that the write goes nowhere. Guessing at the
/// primary is how an outlet on the second PDU gets switched through the first.
/// </para>
/// </summary>
public sealed class DeviceOutletControl : IOutletControl
{
    private readonly PduInstanceRegistry registry;
    private readonly ISnapshotCache snapshots;
    private readonly ILogger<DeviceOutletControl>? log;
    // Devices supplied by plugins, which own their own writes — a PDU can't reach someone else's hardware.
    private readonly IntegrationRegistry? integrations;
    private readonly Config? cfg;
    private readonly ISingleOwnerLease lease;

    public DeviceOutletControl(PduInstanceRegistry registry, ISnapshotCache snapshots,
        ILogger<DeviceOutletControl>? log = null, IntegrationRegistry? integrations = null, Config? cfg = null,
        ISingleOwnerLease? lease = null)
    {
        this.registry = registry;
        this.snapshots = snapshots;
        this.log = log;
        this.integrations = integrations;
        this.cfg = cfg;
        this.lease = lease ?? new SoleOwnerLease();
    }

    /// <summary>
    /// The PDU instance that reported this device, or null when nothing has polled it. A device answers to
    /// either of its names: the entity name it is published under and the key its topic path is built from
    /// are not always the same string, and a command arrives carrying whichever one the sender saw.
    /// </summary>
    public string? InstanceFor(string deviceId)
    {
        foreach (var snapshot in snapshots.All)
            foreach (var device in snapshot.Data.Devices)
                if (string.Equals(device.Entity_Name, deviceId, StringComparison.OrdinalIgnoreCase)
                    || string.Equals(device.Key, deviceId, StringComparison.OrdinalIgnoreCase))
                    return snapshot.InstanceId;
        return null;
    }

    /// <summary>
    /// Every PDU instance that reports a group by this name. Group names are only unique within a PDU — two
    /// may legitimately have a "Rack 1", and a command addressed to that name means both.
    /// </summary>
    public IReadOnlyList<string> InstancesWithGroup(string groupKey)
        => snapshots.All
            .Where(s => s.Data.Groups.Any(g => string.Equals(g.Key, groupKey, StringComparison.OrdinalIgnoreCase)))
            .Select(s => s.InstanceId)
            .ToList();

    public async Task<OutletWriteResult> Control(string deviceId, int outletIndex, string action, CancellationToken cancellationToken = default)
    {
        var act = action.Trim().ToLowerInvariant();
        if (act is not ("on" or "off" or "reboot" or "resetstats"))
        {
            log?.LogWarning("Unknown outlet action '{Action}' for {Device} outlet {Outlet}.", action, deviceId, outletIndex);
            return OutletWriteResult.Refused($"Unknown outlet action '{action}'.");
        }

        // A plugin-supplied device owns its own writes. Checked first, and only ever matching a device this
        // build actually loaded, so nothing changes for a PDU.
        if (PluginFor(deviceId) is { } control)
        {
            if (!control.Supports(act))
                return OutletWriteResult.Refused($"'{deviceId}' does not support '{act}'.");

            var message = $"Another instance owns '{deviceId}'.";
            var applied = await lease.RunIfOwnerAsync($"device:{deviceId}",
                async ct => message = await control.ControlOutletAsync(cfg!, deviceId, outletIndex, act, ct),
                cancellationToken);
            return new OutletWriteResult(applied, message);
        }

        if (!Resolve(deviceId, out var instanceId, out var pdu, out var refusal))
            return OutletWriteResult.Refused(refusal);

        var wrote = await lease.RunIfOwnerAsync($"outlet:{deviceId}|{outletIndex}", async ct =>
        {
            // Writes change the physical world, so they're worth an Information line whatever the log level.
            log?.LogInformation("PDU '{Id}': {Device} outlet {Outlet} → {Action}.", instanceId, deviceId, outletIndex, act);
            switch (act)
            {
                case "on": await pdu!.SetOutletStateAsync(deviceId, outletIndex, true, ct); break;
                case "off": await pdu!.SetOutletStateAsync(deviceId, outletIndex, false, ct); break;
                case "reboot": await pdu!.ControlOutletAsync(deviceId, outletIndex, "reboot", ct); break;
                case "resetstats": await pdu!.ResetOutletStatsAsync(deviceId, outletIndex, ct); break;
            }
        }, cancellationToken);

        return wrote
            ? OutletWriteResult.Applied($"{deviceId} outlet {outletIndex}: {act}.")
            : OutletWriteResult.Refused($"Another instance owns '{deviceId}' outlet {outletIndex}.");
    }

    public async Task<string> SetOutletConfig(string deviceId, int outletIndex, string field, string payload, bool isDelay, CancellationToken cancellationToken = default)
    {
        if (!Resolve(deviceId, out var instanceId, out var pdu, out _)) return "";

        object value;
        if (isDelay)
        {
            // HA sends the number as text; the API wants an integer.
            if (!double.TryParse(payload, System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out var num)) return "";
            value = (long)Math.Round(num);
        }
        else value = payload;   // poaAction etc.: the selected option string

        await lease.RunIfOwnerAsync($"outlet:{deviceId}|{outletIndex}", async ct =>
        {
            log?.LogInformation("PDU '{Id}': {Device} outlet {Outlet} {Field} = {Value}.", instanceId, deviceId, outletIndex, field, value);
            await pdu!.SetOutletConfigAsync(deviceId, outletIndex, new Dictionary<string, object> { [field] = value }, ct);
        }, cancellationToken);
        return value.ToString() ?? "";
    }

    public async Task<OutletWriteResult> ControlGroup(string groupKey, string action, CancellationToken cancellationToken = default)
    {
        var act = action.Trim().ToLowerInvariant();
        if (act is not ("on" or "off" or "reboot")) return OutletWriteResult.Refused($"Unknown group action '{action}'.");

        var applied = 0;
        var results = new List<string>();
        foreach (var instanceId in InstancesWithGroup(groupKey))
        {
            if (!registry.All.TryGetValue(instanceId, out var pdu))
            {
                results.Add($"PDU instance '{instanceId}' is not configured.");
                continue;
            }

            try
            {
                await lease.RunIfOwnerAsync($"group:{instanceId}|{groupKey}", async ct =>
                {
                    log?.LogInformation("PDU '{Id}': group '{Group}' → {Action}.", instanceId, groupKey, act);
                    var count = await pdu.ControlGroupAsync(groupKey, act, ct);
                    log?.LogInformation("PDU '{Id}': group '{Group}' {Action} applied to {Count} outlet(s).", instanceId, groupKey, act, count);
                    results.Add($"Group '{groupKey}' {act}: applied to {count} outlet(s).");
                    applied++;
                }, cancellationToken);
            }
            catch (Exception ex) { results.Add($"{instanceId}: {ex.Message}"); }
        }

        return results.Count == 0
            ? OutletWriteResult.Refused($"No PDU reports a group '{groupKey}' (nothing polled yet, or the name doesn't exist).")
            : new OutletWriteResult(applied > 0, string.Join(" ", results));
    }

    /// <summary>Which PDU this device is on, and whether it can be written to at all.</summary>
    private bool Resolve(string deviceId, out string instanceId, out PDU? pdu, out string refusal)
    {
        pdu = null;
        instanceId = InstanceFor(deviceId) ?? "";
        if (instanceId.Length == 0)
        {
            refusal = $"No PDU has reported device '{deviceId}' — nothing to write to.";
            log?.LogWarning("Write dropped: {Refusal}", refusal);
            return false;
        }
        if (!registry.All.TryGetValue(instanceId, out pdu))
        {
            refusal = $"PDU instance '{instanceId}' is not configured.";
            log?.LogWarning("Write dropped: {Refusal}", refusal);
            return false;
        }
        refusal = "";
        return true;
    }

    /// <summary>
    /// The plugin that owns this device id, or null when a built-in PDU does. A plugin names its own
    /// instance, but the devices it reports carry whatever ids the plugin chose for them — so a write may
    /// address either. Matching only the instance id is how a write to a plugin's device fell through to
    /// the PDU path and was silently refused.
    /// </summary>
    private IDeviceControlPlugin? PluginFor(string deviceId)
    {
        if (integrations is null || cfg is null) return null;

        var instanceId = InstanceFor(deviceId);
        foreach (var i in integrations.All)
            if (i is IDeviceSourcePlugin device && i is IDeviceControlPlugin control
                && (string.Equals(device.InstanceId, deviceId, StringComparison.OrdinalIgnoreCase)
                    || string.Equals(device.InstanceId, instanceId, StringComparison.OrdinalIgnoreCase)))
                return control;
        return null;
    }
}
