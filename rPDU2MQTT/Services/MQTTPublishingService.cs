using rPDU2MQTT.Classes;
using rPDU2MQTT.Services.baseTypes;

namespace rPDU2MQTT.Services;

/// <summary>
/// This class publishes metrics from the PDU, to MQTT.
/// </summary>
public class MQTTPublishingService : basePublishingService
{
    public MQTTPublishingService(MQTTServiceDependancies deps) : base(deps) { }

    protected override async Task Execute(CancellationToken cancellationToken)
    {
        var rootData = await pdu.GetRootData_Public(cancellationToken);
        foreach (var device in rootData.Devices.Values)
        {
            await PublishState(device, cancellationToken);

            foreach (var entity in device.Entity.Values)
            {
                await PublishName(entity, cancellationToken);
                await PublishUniqueIdentifier(entity, cancellationToken);
                await PublishMeasurements(entity.Measurements, cancellationToken);
            }
            foreach (var outlet in device.Outlets.Values)
            {
                await PublishName(outlet, cancellationToken);
                await PublishUniqueIdentifier(outlet, cancellationToken);
                await PublishState(outlet, cancellationToken);
                await PublishMeasurements(outlet.Measurements, cancellationToken);
            }
        }
    }
}