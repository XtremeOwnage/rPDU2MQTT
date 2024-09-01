using HiveMQtt.MQTT5.Types;
using Microsoft.Extensions.Logging;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Extensions;
using rPDU2MQTT.Helpers;
using rPDU2MQTT.Interfaces;
using rPDU2MQTT.Models.HomeAssistant;
using rPDU2MQTT.Models.HomeAssistant.baseClasses;
using rPDU2MQTT.Models.HomeAssistant.DiscoveryTypes;
using rPDU2MQTT.Models.PDU;
using rPDU2MQTT.Models.PDU.DummyDevices;

namespace rPDU2MQTT.Services.baseTypes;

public abstract class baseDiscoveryService : baseMQTTTService
{
    public baseDiscoveryService(MQTTServiceDependancies deps, ILogger log) : base(deps, log, deps.Cfg.HASS.DiscoveryInterval) { }

    /// <summary>
    /// Publish a discovery message for the specified <paramref name="measurement"/>, for device <paramref name="Parent"/>
    /// </summary>
    /// <param name="measurement"></param>
    /// <param name="Parent"></param>
    /// <param name="cancellationToken"></param>
    public Task DiscoverMeasurementAsync(Measurement measurement, DiscoveryDevice Parent, CancellationToken cancellationToken)
    {
        //If we are unable to parse this measurement as valid, skip to the next.
        var dto = measurement.TryParseValue();

        var discovery = new SensorDiscovery
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
            ValueTemplate = "{{ value }}",


            // Availability
            //Availability = new Models.HomeAssistant.baseClasses.EntityAvailability
        };

        return PushDiscoveryMessage(discovery, cancellationToken);
    }

    public Task DiscoverStateAsync<T>(T item, DiscoveryDevice Parent, CancellationToken cancellationToken) where T : NamedEntity, IEntityWithState
    {
        var discovery = new BinarySensorDiscovery
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

            //Availbility
            //Availability = outlet.GetAvailability()
        };

        return PushDiscoveryMessage(discovery, cancellationToken);
    }

    /// <summary>
    /// Bulk publish all discoveries.
    /// </summary>
    /// <remarks>
    /// This will automatically split results by Device, and EntityType.
    /// </remarks>
    /// <typeparam name="T"></typeparam>
    /// <param name="Discoveries"></param>
    /// <param name="cancellationToken"></param>
    /// <returns></returns>
    protected async Task PushDiscoveryMessages<T>(List<T> Discoveries, CancellationToken cancellationToken) where T : baseEntity
    {
        foreach (T sensor in Discoveries)
            await PushDiscoveryMessage(sensor, cancellationToken);
    }

    protected Task PushDiscoveryMessage<T>(T sensor, CancellationToken cancellationToken) where T : baseEntity
    {
        var topic = $"{cfg.HASS.DiscoveryTopic}/{sensor.EntityType.ToJsonString()}/{sensor.ID}/config";

        log.LogDebug($"Publishing Discovery of type {sensor.EntityType.ToJsonString()} for {sensor.ID} to {topic}");

        var msg = new MQTT5PublishMessage(topic, QualityOfService.AtLeastOnceDelivery)
        {
            ContentType = "json",
            PayloadAsString = System.Text.Json.JsonSerializer.Serialize<T>(sensor, this.jsonOptions)
        };

        if (cfg.Debug.PrintDiscovery)
            log.LogDebug(msg.PayloadAsString);

        return this.Publish(msg, cancellationToken);
    }
}


