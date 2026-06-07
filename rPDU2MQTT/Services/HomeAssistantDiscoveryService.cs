using rPDU2MQTT.Classes;
using rPDU2MQTT.Extensions;
using rPDU2MQTT.Models.HomeAssistant;
using rPDU2MQTT.Models.HomeAssistant.baseClasses;
using rPDU2MQTT.Models.PDU;
using rPDU2MQTT.Models.PDU.DummyDevices;
using rPDU2MQTT.Models.PDU.OneView;
using rPDU2MQTT.Services.baseTypes;
using System.Diagnostics.CodeAnalysis;

namespace rPDU2MQTT.Services;

/// <summary>
/// This class publishes metrics from the PDU, to MQTT.
/// </summary>
public class HomeAssistantDiscoveryService : baseDiscoveryService
{
    public HomeAssistantDiscoveryService(MQTTServiceDependencies deps) : base(deps) { }

    protected override async Task Execute(CancellationToken cancellationToken)
    {
        Log.Debug("Starting discovery job.");
        var data = await pdu.GetRootData_Public(cancellationToken);

        // Collect every entity, then publish one device-based discovery message per device.
        var components = new List<baseEntity>();

        // Discover PDUs, Outlets, etc...
        foreach (rPDU nestedPDU in data.PDUs)
        {
            var pduDevice = nestedPDU.GetDiscoveryDevice();
            collectDiscovery(nestedPDU.Devices, pduDevice, components);
        }

        // Discover OneView Groups.
        var firstPDU = data.PDUs.FirstOrDefault()?.GetDiscoveryDevice();
        if (firstPDU is not null)
            collectDiscovery(data.Groups, firstPDU, components);

        await PublishDeviceDiscoveries(components, cancellationToken);

        Log.Information("Discovery information published.");
    }


    private void collectDiscovery<TEntity>([AllowNull] TEntity entity, DiscoveryDevice parent, List<baseEntity> components) where TEntity : BaseEntity
    {
        if (entity is null)
            return;
        else if (entity is Device device)
        {
            // Create a device, to represent this device.
            var newParent = parent.CreateChild(device);

            // Discover outlets.
            collectDiscovery(device.Outlets, newParent, components);

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
                .FirstOrDefault();

            collectDiscovery(rootEntity!, newParent, components);
            #endregion

        }
        else if (entity is Outlet outlet)
        {
            // Create a device to represent the outlet.
            var newParent = parent.CreateChild(outlet);

            // Remap Make/Model, IF specified in the configuration.
            RemapColumns(newParent, "Outlet", outlet.Name);

            // Discover outlet's state.
            components.Add(BuildState(outlet, newParent));

            // Discover measurements
            collectDiscovery(outlet.Measurements, newParent, components);
        }
        else if (entity is Entity pduEntity)
        {
            // Discover measurements
            collectDiscovery(pduEntity.Measurements, parent, components);
        }
        else if (entity is Measurement measurement)
        {
            if (BuildMeasurement(measurement, parent) is { } sensor)
                components.Add(sensor);
        }
        else if (entity is GroupMeasurement groupMeasurement)
        {
            if (BuildGroupMeasurement(groupMeasurement, parent) is { } sensor)
                components.Add(sensor);
        }
        else if (entity is OneViewGroup group)
        {
            // Create a device to represent the group.
            var newParent = parent.CreateChild(group);

            // Remap Make/Model, IF specified in the configuration.
            RemapColumns(newParent, "Oneview Group", group.Label);

            // Discover measurements.
            collectDiscovery(group.Entity.Outlets.SelectMany(o => o.Measurements), newParent, components);
        }
    }

    private void collectDiscovery<TEntity>(IEnumerable<TEntity> entities, DiscoveryDevice parent, List<baseEntity> components)
        where TEntity : BaseEntity
    {
        foreach (var entity in entities)
            collectDiscovery(entity, parent, components);
    }

    private void collectDiscovery<TKey, TEntity>(Dictionary<TKey, TEntity> entities, DiscoveryDevice parent, List<baseEntity> components) where TEntity : BaseEntity
    {
        foreach (var (_, entity) in entities)
            collectDiscovery(entity, parent, components);
    }
}
