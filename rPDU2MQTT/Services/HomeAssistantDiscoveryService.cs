using Microsoft.Extensions.Logging;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Extensions;
using rPDU2MQTT.Models.HomeAssistant;
using rPDU2MQTT.Models.PDU;
using rPDU2MQTT.Models.PDU.DummyDevices;
using rPDU2MQTT.Services.baseTypes;
using System.Diagnostics.CodeAnalysis;

namespace rPDU2MQTT.Services;

/// <summary>
/// This class publishes metrics from the PDU, to MQTT.
/// </summary>
public class HomeAssistantDiscoveryService : baseDiscoveryService
{
    public HomeAssistantDiscoveryService(MQTTServiceDependancies deps) : base(deps) { }

    protected override async Task Execute(CancellationToken cancellationToken)
    {
        var data = await pdu.GetRootData_Public(cancellationToken);
        var pduDevice = data.GetDiscoveryDevice();

        Log.Debug("Starting discovery job.");

        // Recursively discover everything.
        await recursiveDiscovery(data.Devices, pduDevice, cancellationToken);

        Log.Information("Discovery information published.");
    }


    protected async Task recursiveDiscovery<TEntity>([AllowNull] TEntity entity, DiscoveryDevice parent, CancellationToken cancellationToken) where TEntity : BaseEntity
    {
        if (entity is null)
            return;
        else if (entity is Device device)
        {
            // Create a device, to represent this device.
            var newParent = parent.CreateChild(device);

            // Discover outlets.
            await recursiveDiscovery(device.Outlets, newParent, cancellationToken);

            #region Hack - Discover Entities
            // Discover Entity
            // Hack- but, for my testing data, my PDU exposes four seperate entities.
            // (outlets) -> (breaker0, breaker1) -> (phase0)
            // And, total0
            // I don't really see any value in getting the data for the breakers, as it doesn't really correspond to any useful data.
            // As such- the phase0, and total0 entities are the only interesting ones...
            // And, as it turns out- they both expose the same data, but, phase0 exposes more sensors (such as voltage, and other data that does not total very well)
            // So- Only want to discover the ROOT value.
            // To do this- we are just going to find the entity, at the top of the layout.

            // In my testing, the root entity, contains a single name, "entity/phase0". So- this next line, extracts, "phase0"
            var rootEntityName = device.Layout[0].First().Split("/", StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries).Last();

            var rootEntity = device.Entity
                .Where(o => o.Key == rootEntityName)
                .Select(o => o.Value)
                .FirstOrDefault();

            await recursiveDiscovery(rootEntity!, newParent, cancellationToken);
            #endregion

        }
        else if (entity is Outlet outlet)
        {
            // Create a device to represent the outlet.
            var newParent = parent.CreateChild(outlet);

            // Discover outlet's state.
            await DiscoverStateAsync(outlet, newParent, cancellationToken);

            // Discover measurements
            await recursiveDiscovery(outlet.Measurements, newParent, cancellationToken);
        }
        else if (entity is Entity pduEntity)
        {
            // Discover measurements
            await recursiveDiscovery(pduEntity.Measurements, parent, cancellationToken);
        }
        else if (entity is Measurement measurement)
        {
            await DiscoverMeasurementAsync(measurement, parent, cancellationToken);
        }
    }

    protected async Task recursiveDiscovery<TKey, TEntity>(Dictionary<TKey, TEntity> entities, DiscoveryDevice parent, CancellationToken cancellationToken) where TEntity : BaseEntity
    {
        foreach (var (_, entity) in entities)
            await recursiveDiscovery(entity, parent, cancellationToken);
    }

}