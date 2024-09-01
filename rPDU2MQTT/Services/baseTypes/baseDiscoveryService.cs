using HiveMQtt.MQTT5.Types;
using Microsoft.Extensions.Logging;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Extensions;
using rPDU2MQTT.Helpers;
using rPDU2MQTT.Models.HomeAssistant;
using rPDU2MQTT.Models.HomeAssistant.baseClasses;
using rPDU2MQTT.Models.HomeAssistant.DiscoveryTypes;
using rPDU2MQTT.Models.PDU;

namespace rPDU2MQTT.Services.baseTypes;

public abstract class baseDiscoveryService : baseMQTTTService
{
    public baseDiscoveryService(MQTTServiceDependancies deps, ILogger log) : base(deps, log, deps.Cfg.HASS.DiscoveryInterval) { }

    public Sensor CreateSensorDiscovery(Measurement measurement, DiscoveryDevice Device)
    {
        //If we are unable to parse this measurement as valid, skip to the next.
        var dto = measurement.TryParseValue();

        var sensor = new Sensor
        {
            //Identifying Details
            ID = measurement.Entity_Identifier,
            Name = measurement.Entity_Name,
            DisplayName = measurement.Entity_DisplayName,

            //Device Details
            Device = Device,

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

        return sensor;
    }

    /// <summary>
    /// Bulk publish all discoveries.
    /// </summary>
    /// <remarks>
    /// This will automatically split results by Device, and EntityType.
    /// </remarks>
    /// <typeparam name="T"></typeparam>
    /// <param name="Sensors"></param>
    /// <param name="cancellationToken"></param>
    /// <returns></returns>
    protected async Task PublishDeviceSensors<T>(List<T> Sensors, CancellationToken cancellationToken) where T : baseEntity
    {
        foreach (T sensor in Sensors)
        {
            var topic = $"{cfg.HASS.DiscoveryTopic}/{sensor.EntityType.ToJsonString()}/{sensor.ID}/config";

            log.LogDebug($"Publishing Discovery of type {sensor.EntityType.ToJsonString()} for {sensor.ID} to {topic}");

            var msg = new MQTT5PublishMessage(topic, QualityOfService.AtLeastOnceDelivery)
            {
                ContentType = "json",
                PayloadAsString = System.Text.Json.JsonSerializer.Serialize<T>(sensor, this.jsonOptions)
            };

            Console.WriteLine(msg.PayloadAsString);

            await this.Publish(msg, cancellationToken);
        }
    }
}


