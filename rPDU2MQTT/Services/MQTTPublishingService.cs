using rPDU2MQTT.Classes;
using rPDU2MQTT.Services.baseTypes;

namespace rPDU2MQTT.Services;

/// <summary>
/// This class publishes metrics from the PDU, to MQTT.
/// </summary>
public class MQTTPublishingService : basePublishingService
{
    public MQTTPublishingService(MQTTServiceDependencies deps) : base(deps) { }

    protected override async Task Execute(CancellationToken cancellationToken)
    {
        var data = await pdu.GetRootData_Public(cancellationToken);

        // Run through each device.
        foreach (var device in data.Devices)
        {
            await PublishState(device, cancellationToken);
            await PublishAlarm(device, device.Alarm, cancellationToken);

            foreach (var entity in device.Entity)
            {
                await PublishName(entity, cancellationToken);
                await PublishUniqueIdentifier(entity, cancellationToken);
                await PublishMeasurements(entity.Measurements, cancellationToken);
            }
            foreach (var outlet in device.Outlets)
            {
                // While a control command is still pending, report the commanded state instead of
                // the stale polled one so HA doesn't flap back during the PDU's apply delay.
                // (Don't mutate the polled data; it may be shared via the data cache.)
                var state = pdu.ResolveOutletState(device.Key, outlet.Key, outlet.State);

                await PublishName(outlet, cancellationToken);
                await PublishUniqueIdentifier(outlet, cancellationToken);
                await PublishState(outlet, state, cancellationToken);
                await PublishAlarm(outlet, outlet.Alarm, cancellationToken);
                await PublishMeasurements(outlet.Measurements, cancellationToken);

                // Current values backing the writable delay/power-on entities (when control is enabled).
                if (cfg.PDU.ActionsEnabled)
                    await PublishOutletConfig(device.Key, outlet, cancellationToken);
            }
        }

        foreach (var group in data.Groups)
        {
            await PublishName(group, cancellationToken);
            await PublishUniqueIdentifier(group, cancellationToken);

            // Per-group aggregates, plus the cluster-wide total (the "Total" group's pduTotal).
            foreach (var outlet in group.Entity.Outlets.Concat(group.Entity.PduTotal))
            {
                await PublishOneViewGroupMeasurements(outlet.Measurements, cancellationToken);
            }
        }
    }
}