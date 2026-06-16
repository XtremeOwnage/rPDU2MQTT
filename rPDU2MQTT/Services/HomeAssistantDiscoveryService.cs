using rPDU2MQTT.Classes;
using rPDU2MQTT.Extensions;
using rPDU2MQTT.Helpers;
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
    private readonly SemaphoreSlim discoveryLock = new(1, 1);

    public HomeAssistantDiscoveryService(MQTTServiceDependencies deps, DiscoveryCoordinator coordinator) : base(deps)
    {
        // Allow the "Rediscover" diagnostic button to trigger an on-demand republish.
        coordinator.RediscoverRequested += Execute;
        // Allow the "Clear discovery" action (GUI) to remove the retained discovery messages.
        coordinator.ClearRequested += ClearDiscoveries;
    }

    private async Task ClearDiscoveries(CancellationToken cancellationToken)
    {
        await discoveryLock.WaitAsync(cancellationToken);
        try
        {
            var cleared = await ClearAllDiscoveries(cancellationToken);
            Log.Information($"Cleared {cleared} Home Assistant discovery topic(s).");
        }
        finally
        {
            discoveryLock.Release();
        }
    }

    protected override async Task Execute(CancellationToken cancellationToken)
    {
        // The timer and the on-demand rediscover trigger can both call this; don't overlap.
        if (!await discoveryLock.WaitAsync(0, cancellationToken))
        {
            Log.Debug("Discovery already in progress; skipping this request.");
            return;
        }

        try
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

            // Bridge device with diagnostic action buttons.
            components.AddRange(BuildDiagnosticButtons());

            await PublishDeviceDiscoveries(components, cancellationToken);

            Log.Information("Discovery information published.");
        }
        finally
        {
            discoveryLock.Release();
        }
    }

    /// <summary>Buttons for the bridge device: rediscover and restart (see DiagnosticService).</summary>
    private IEnumerable<baseEntity> BuildDiagnosticButtons()
    {
        var bridge = new DiscoveryDevice
        {
            UniqueIdentifier = "rPDU2MQTT",
            Name = "rPDU2MQTT",
            Manufacturer = "rPDU2MQTT",
            Model = "MQTT Bridge",
        };

        yield return BuildButton("rPDU2MQTT_rediscover", "Rediscover",
            MQTTHelper.JoinPaths(cfg.MQTT.ParentTopic, MQTTHelper.RediscoverSuffix), bridge);
        yield return BuildButton("rPDU2MQTT_restart", "Restart",
            MQTTHelper.JoinPaths(cfg.MQTT.ParentTopic, MQTTHelper.RestartSuffix), bridge, deviceClass: "restart");
    }

    private void collectDiscovery<TEntity>([AllowNull] TEntity entity, DiscoveryDevice parent, List<baseEntity> components) where TEntity : BaseEntity
    {
        if (entity is null)
            return;
        else if (entity is Device device)
        {
            // Create a device, to represent this device.
            var newParent = parent.CreateChild(device);
            ApplyMakeModelOverride(newParent, device);

            // Device-level alarm.
            components.Add(BuildAlarm(device, newParent));

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

            // In my testing, the root entity, contains a single name, "entity/phase0". So- this extracts "phase0".
            string? rootEntityName = null;
            if (device.Layout is not null && device.Layout.TryGetValue(0, out var rootLayout) && rootLayout.Length > 0)
                rootEntityName = rootLayout[0].Split("/", StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries).LastOrDefault();

            if (!string.IsNullOrEmpty(rootEntityName))
            {
                var rootEntity = device.Entity.FirstOrDefault(o => o.Key == rootEntityName);
                collectDiscovery(rootEntity!, newParent, components);
            }
            #endregion

        }
        else if (entity is Outlet outlet)
        {
            // Create a device to represent the outlet. Prefix with the PDU name so outlets
            // stay distinguishable across multiple PDUs (e.g. "Rack-PDU-1 Dell: r730XD").
            var newParent = parent.CreateChild(outlet, prefixWithParentName: true);

            // Remap Make/Model, IF specified in the configuration.
            RemapColumns(newParent, "Outlet", outlet.Name);
            // Per-outlet Make/Model override wins over the remap/inherited values.
            ApplyMakeModelOverride(newParent, outlet);

            // Discover outlet's state.
            components.Add(BuildState(outlet, newParent));

            // Outlet-level alarm.
            components.Add(BuildAlarm(outlet, newParent));

            // When write-actions are enabled, also expose the outlet as a controllable switch.
            if (cfg.PDU.ActionsEnabled)
                components.Add(BuildSwitch(outlet, newParent));

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
            ApplyMakeModelOverride(newParent, group);

            // Discover measurements (per-group aggregate, and the cluster-wide PduTotal rollup).
            collectDiscovery(group.Entity.Outlets.Concat(group.Entity.PduTotal).SelectMany(o => o.Measurements), newParent, components);
        }
    }

    private void collectDiscovery<TEntity>(IEnumerable<TEntity> entities, DiscoveryDevice parent, List<baseEntity> components)
        where TEntity : BaseEntity
    {
        foreach (var entity in entities)
            collectDiscovery(entity, parent, components);
    }

    private void collectDiscovery<TKey, TEntity>(Dictionary<TKey, TEntity> entities, DiscoveryDevice parent, List<baseEntity> components) where TKey : notnull where TEntity : BaseEntity
    {
        foreach (var (_, entity) in entities)
            collectDiscovery(entity, parent, components);
    }
}
