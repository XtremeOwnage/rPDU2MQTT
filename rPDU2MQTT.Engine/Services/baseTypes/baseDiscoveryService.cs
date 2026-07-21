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
    /// How long a state may go without an update before HA marks it unavailable
    /// (HomeAssistant.SensorExpireAfterSeconds).
    /// </summary>
    private TimeSpan StateExpiry => TimeSpan.FromSeconds(cfg.HASS.SensorExpireAfterSeconds);

    /// <summary>
    /// The availability (LWT) topic for entities, or null when Last-Will is disabled
    /// (entities then rely on expire_after to go unavailable).
    /// </summary>
    private string? Availability => cfg.MQTT.LastWill ? MQTTHelper.StatusTopic(cfg.MQTT.ParentTopic) : null;

    /// <summary>
    /// Build a sensor discovery for the specified <paramref name="measurement"/>, for device <paramref name="Parent"/>.
    /// Returns <see langword="null"/> if the measurement cannot be parsed.
    /// </summary>
    public baseEntity? BuildMeasurement(Measurement measurement, DiscoveryDevice Parent)
        // #205: the template has to match the payload shape the publisher is using, or Home Assistant reads
        // the whole JSON document as the state.
        => BuildMeasurement((baseMeasurement)measurement, Parent, Core.MessageTimestamps.ValueTemplate(cfg.MQTT.MessageTimestamp));

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

            ExpireAfter = StateExpiry,
            AvailabilityTopic = Availability,
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

            AvailabilityTopic = Availability,
        };
    }

    /// <summary>
    /// Build a stateless button entity that publishes to <paramref name="commandTopic"/> when pressed.
    /// </summary>
    public ButtonDiscovery BuildButton(string id, string displayName, string commandTopic, DiscoveryDevice Parent, string? deviceClass = null, string payloadPress = "PRESS")
    {
        return new ButtonDiscovery
        {
            ID = id,
            Name = id,
            DisplayName = displayName,

            Device = Parent,
            EntityType = Models.HomeAssistant.Enums.EntityType.Button,
            EntityCategory = EntityCategory.Diagnostic,
            DeviceClass = deviceClass,

            CommandTopic = commandTopic,
            PayloadPress = payloadPress,
            AvailabilityTopic = Availability,
        };
    }

    /// <summary>
    /// Build a writable numeric setting (Home Assistant number) bound to <paramref name="stateTopic"/>,
    /// publishing the new value to <paramref name="commandTopic"/>.
    /// </summary>
    public NumberDiscovery BuildNumber(string id, string displayName, string stateTopic, string commandTopic,
        DiscoveryDevice Parent, double? min = null, double? max = null, double? step = null, string? unit = null)
    {
        return new NumberDiscovery
        {
            ID = id,
            Name = id,
            DisplayName = displayName,

            Device = Parent,
            EntityType = Models.HomeAssistant.Enums.EntityType.Number,
            EntityCategory = EntityCategory.Config,

            StateTopic = stateTopic,
            CommandTopic = commandTopic,
            Min = min,
            Max = max,
            Step = step,
            UnitOfMeasurement = unit,

            AvailabilityTopic = Availability,
        };
    }

    /// <summary>
    /// Build a writable enumerated setting (Home Assistant select) bound to <paramref name="stateTopic"/>,
    /// publishing the chosen option to <paramref name="commandTopic"/>.
    /// </summary>
    public SelectDiscovery BuildSelect(string id, string displayName, string stateTopic, string commandTopic,
        IEnumerable<string> options, DiscoveryDevice Parent)
    {
        return new SelectDiscovery
        {
            ID = id,
            Name = id,
            DisplayName = displayName,

            Device = Parent,
            EntityType = Models.HomeAssistant.Enums.EntityType.Select,
            EntityCategory = EntityCategory.Config,

            StateTopic = stateTopic,
            CommandTopic = commandTopic,
            Options = options.ToList(),

            AvailabilityTopic = Availability,
        };
    }

    /// <summary>
    /// Build a "problem" binary sensor reflecting an entity's alarm state.
    /// </summary>
    public BinarySensorDiscovery BuildAlarm(NamedEntity item, DiscoveryDevice Parent)
    {
        return new BinarySensorDiscovery
        {
            ID = item.Entity_Identifier + "_alarm",
            Name = item.Entity_Name + "_alarm",
            DisplayName = "Alarm",

            Device = Parent,
            EntityType = Models.HomeAssistant.Enums.EntityType.BinarySensor,
            EntityCategory = EntityCategory.Diagnostic,
            DeviceClass = "problem",

            StateTopic = MQTTHelper.JoinPaths(item.GetTopicPath(), MqttPath.Alarm.ToJsonString()),
            // Map the raw alarm state: "none" -> no problem, anything else -> problem.
            ValueTemplate = "{{ 'OFF' if value == 'none' else 'ON' }}",
            PayloadOn = "ON",
            PayloadOff = "OFF",

            ExpireAfter = StateExpiry,
            AvailabilityTopic = Availability,
        };
    }

    /// <summary>
    /// Build discoveries for a group measurement: the aggregated <c>sum</c> (primary, kept under the
    /// existing id), plus avg/min/max sensors when the PDU reports them.
    /// </summary>
    protected IEnumerable<baseEntity> BuildGroupMeasurements(GroupMeasurement measurement, DiscoveryDevice Parent)
    {
        // The display base ("(Sum)/(Avg)/(Min)/(Max)" appended) comes from Entity_DisplayName, which is
        // overridable via Overrides.OneviewGroups.Measurements.<type>.Name.
        foreach (var (suffix, label, template, present) in new[]
        {
            // Sum is always emitted; its id stays unsuffixed for continuity with existing installs.
            ("sum", "Sum", "{{ value_json.sum }}", true),
            ("avg", "Avg", "{{ value_json.avg }}", !string.IsNullOrEmpty(measurement.AvgValue)),
            ("min", "Min", "{{ value_json.min }}", !string.IsNullOrEmpty(measurement.MinValue)),
            ("max", "Max", "{{ value_json.max }}", !string.IsNullOrEmpty(measurement.MaxValue)),
        })
        {
            if (!present || BuildMeasurement(measurement, Parent, template) is not SensorDiscovery s)
                continue;
            if (suffix != "sum")
            {
                s.ID = measurement.Entity_Identifier + "_" + suffix;
                s.Name = measurement.Entity_Name + "_" + suffix;
            }
            s.DisplayName = measurement.Entity_DisplayName + " (" + label + ")";
            yield return s;
        }
    }

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

            ExpireAfter = StateExpiry,
            AvailabilityTopic = Availability,
        };
    }

    // Device discovery topics published on the previous run, so we can clear ones that disappear.
    private readonly HashSet<string> publishedDeviceTopics = new();

    /// <summary>
    /// Publish device-based discovery: one retained message per device containing all of its
    /// entities as components. Devices that were published previously but are no longer present
    /// have their retained discovery message cleared so they don't linger in Home Assistant.
    /// </summary>
    protected async Task PublishDeviceDiscoveries(IEnumerable<baseEntity> components, CancellationToken cancellationToken)
    {
        var currentTopics = new HashSet<string>();

        foreach (var group in components.GroupBy(c => c.Device.UniqueIdentifier))
        {
            var device = new DeviceDiscovery
            {
                Device = group.First().Device,
                Components = group.ToDictionary(c => c.ID, c => c),
            };

            currentTopics.Add(DeviceTopic(device.Device.UniqueIdentifier));
            await PublishDeviceDiscovery(device, cancellationToken);
        }

        foreach (var staleTopic in publishedDeviceTopics.Except(currentTopics))
        {
            Log.Information($"Clearing stale discovery topic {staleTopic}");
            await ClearRetained(staleTopic, cancellationToken);
        }

        publishedDeviceTopics.Clear();
        publishedDeviceTopics.UnionWith(currentTopics);
    }

    /// <summary>
    /// Clear every retained discovery message this service has published, so Home Assistant drops
    /// the entities. Returns the number of topics cleared.
    /// </summary>
    protected async Task<int> ClearAllDiscoveries(CancellationToken cancellationToken)
    {
        var topics = publishedDeviceTopics.ToList();
        foreach (var topic in topics)
        {
            Log.Information($"Clearing discovery topic {topic}");
            await ClearRetained(topic, cancellationToken);
        }

        publishedDeviceTopics.Clear();
        return topics.Count;
    }

    private string DeviceTopic(string deviceIdentifier) => $"{cfg.HASS.DiscoveryTopic}/device/{deviceIdentifier}/config";

    private Task PublishDeviceDiscovery(DeviceDiscovery device, CancellationToken cancellationToken)
    {
        var topic = DeviceTopic(device.Device.UniqueIdentifier);

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

    /// <summary>Clear a retained topic by publishing a zero-length retained message.</summary>
    private Task ClearRetained(string topic, CancellationToken cancellationToken)
    {
        var msg = new MQTT5PublishMessage(topic, QualityOfService.AtLeastOnceDelivery)
        {
            PayloadAsString = string.Empty,
            Retain = true,
        };

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

        if (cfg.Primary.RemapModel)
            discoveryDevice.Model = $"{parent.Name} {Model}";

        if (cfg.Primary.RemapManufacturer)
            discoveryDevice.Manufacturer = Make;

    }

    /// <summary>
    /// Apply per-entity Manufacturer/Model overrides (Overrides.*.Make/Model) to a discovery device.
    /// Takes precedence over the inherited values and the RemapColumns behavior.
    /// </summary>
    protected static void ApplyMakeModelOverride(DiscoveryDevice discoveryDevice, NamedEntity entity)
    {
        if (!string.IsNullOrWhiteSpace(entity.Entity_Make))
            discoveryDevice.Manufacturer = entity.Entity_Make;

        if (!string.IsNullOrWhiteSpace(entity.Entity_Model))
            discoveryDevice.Model = entity.Entity_Model;
    }
}


