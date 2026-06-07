using HiveMQtt.MQTT5.Types;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Extensions;
using rPDU2MQTT.Helpers;
using rPDU2MQTT.Interfaces;
using rPDU2MQTT.Models.HomeAssistant;
using rPDU2MQTT.Models.HomeAssistant.baseClasses;
using rPDU2MQTT.Models.HomeAssistant.DiscoveryTypes;
using rPDU2MQTT.Models.PDU;
using rPDU2MQTT.Models.PDU.basePDU;
using rPDU2MQTT.Models.PDU.DummyDevices;

namespace rPDU2MQTT.Services.baseTypes;

public abstract class baseDiscoveryService : baseMQTTService
{
    public baseDiscoveryService(MQTTServiceDependencies deps) : base(deps, deps.Cfg.HASS.DiscoveryInterval) { }

    /// <summary>
    /// Build a sensor discovery for the specified <paramref name="measurement"/>, for device <paramref name="Parent"/>.
    /// Returns <see langword="null"/> if the measurement cannot be parsed.
    /// </summary>
    public baseEntity? BuildMeasurement(Measurement measurement, DiscoveryDevice Parent)
        => BuildMeasurement((baseMeasurement)measurement, Parent, "{{ value }}");

    public BinarySensorDiscovery BuildState<T>(T item, DiscoveryDevice Parent) where T : NamedEntity, IEntityWithState
    {
        return new BinarySensorDiscovery
        {
            //Identifying Details
            ID = item.Entity_Identifier + "_state",
            Name = item.Entity_Name + "_state",
            DisplayName = $"State",

            //Device Details
            Device = Parent,

            //Sensor Specific Details
            EntityType = Models.HomeAssistant.Enums.EntityType.BinarySensor,
            EntityCategory = null,

            //State - Pulled from IEntityWithState
            StateTopic = item.GetStateTopic(),
            ValueTemplate = item.State_ValueTemplate,
            PayloadOn = item.State_On,
            PayloadOff = item.State_Off,

            AvailabilityTopic = MQTTHelper.StatusTopic(cfg.MQTT.ParentTopic),
        };
    }

    /// <summary>
    /// Build a switch discovery so a controllable outlet can be toggled from Home Assistant.
    /// The switch shares the outlet's existing state topic and adds a command topic.
    /// </summary>
    public SwitchDiscovery BuildSwitch<T>(T item, DiscoveryDevice Parent) where T : NamedEntity, IEntityWithState
    {
        return new SwitchDiscovery
        {
            ID = item.Entity_Identifier + "_switch",
            Name = item.Entity_Name + "_switch",
            DisplayName = "Switch",

            Device = Parent,
            EntityType = Models.HomeAssistant.Enums.EntityType.Switch,

            StateTopic = item.GetStateTopic(),
            ValueTemplate = item.State_ValueTemplate,
            StateOn = item.State_On,
            StateOff = item.State_Off,
            PayloadOn = item.State_On,
            PayloadOff = item.State_Off,
            CommandTopic = MQTTHelper.JoinPaths(item.GetTopicPath(), MqttPath.Set.ToJsonString()),

            AvailabilityTopic = MQTTHelper.StatusTopic(cfg.MQTT.ParentTopic),
        };
    }

    /// <summary>
    /// Build a discovery for a group measurement, bound to its aggregated <c>sum</c> value.
    /// </summary>
    protected baseEntity? BuildGroupMeasurement(GroupMeasurement measurement, DiscoveryDevice Parent)
        => BuildMeasurement(measurement, Parent, "{{ value_json.sum }}");

    private SensorDiscovery? BuildMeasurement(baseMeasurement measurement, DiscoveryDevice Parent, string valueTemplate)
    {
        //If we are unable to parse this measurement as valid, skip to the next.
        var dto = measurement.TryParseValue();

        if (dto is null)
            return null;

        return new SensorDiscovery
        {
            //Identifying Details
            ID = measurement.Entity_Identifier,
            Name = measurement.Entity_Name,
            DisplayName = measurement.Entity_DisplayName,

            //Device Details
            Device = Parent,

            //Sensor Specific Details
            EntityType = Models.HomeAssistant.Enums.EntityType.Sensor,
            EntityCategory = null,  // Leave null, as there is not a category for "sensors".
            SensorClass = dto.SensorClass,
            StateClass = dto.StateClass,

            //Specific to this sensor.
            StateTopic = measurement.GetTopicPath(),
            UnitOfMeasurement = measurement.Units,
            ValueTemplate = valueTemplate,

            AvailabilityTopic = MQTTHelper.StatusTopic(cfg.MQTT.ParentTopic),
        };
    }

    /// <summary>
    /// Publish device-based discovery: one retained message per device containing all of its
    /// entities as components.
    /// </summary>
    protected async Task PublishDeviceDiscoveries(IEnumerable<baseEntity> components, CancellationToken cancellationToken)
    {
        foreach (var group in components.GroupBy(c => c.Device.UniqueIdentifier))
        {
            var device = new DeviceDiscovery
            {
                Device = group.First().Device,
                Components = group.ToDictionary(c => c.ID, c => c),
            };

            await PublishDeviceDiscovery(device, cancellationToken);
        }
    }

    private Task PublishDeviceDiscovery(DeviceDiscovery device, CancellationToken cancellationToken)
    {
        var topic = $"{cfg.HASS.DiscoveryTopic}/device/{device.Device.UniqueIdentifier}/config";

        Log.Debug($"Publishing device discovery for {device.Device.UniqueIdentifier} ({device.Components.Count} components) to {topic}");

        var msg = new MQTT5PublishMessage(topic, QualityOfService.AtLeastOnceDelivery)
        {
            ContentType = "json",
            PayloadAsString = System.Text.Json.JsonSerializer.Serialize(device, this.jsonOptions),
            Retain = cfg.HASS.DiscoveryRetain,
        };

        if (cfg.Debug.PrintDiscovery)
            Log.Debug(msg.PayloadAsString);

        return this.Publish(msg, cancellationToken);
    }

    /// <summary>
    /// If the configuration allows remapping make/model, this method will do it automatially.
    /// </summary>
    /// <param name="discoveryDevice"></param>
    /// <param name="Make">This will be the value placed into the Manufacturer column, if enabled.</param>
    /// <param name="Model">This will be the value APPENDED to the parent device's name, if enabled.</param>
    protected void RemapColumns(DiscoveryDevice discoveryDevice, string Make, string Model)
    {
        var parent = discoveryDevice.ParentDevice;
        if (parent is null)
            return;

        if (cfg.PDU.RemapModel)
            discoveryDevice.Model = $"{parent.Name} {Model}";

        if (cfg.PDU.RemapManufacturer)
            discoveryDevice.Manufacturer = Make;

    }
}


