using rPDU2MQTT.Models.HomeAssistant.baseClasses;
using rPDU2MQTT.Models.HomeAssistant.Enums;
using System.Text.Json.Serialization;

namespace rPDU2MQTT.Models.HomeAssistant.DiscoveryTypes;

public class Sensor : baseSensorEntity
{
    [JsonPropertyName("device_class")]
    public DeviceClass? SensorClass { get; set; }

    /// <summary>
    /// The state_class of the sensor. 
    /// </summary>
    [JsonPropertyName("state_class")]
    public StateClass? StateClass { get; set; }

    [JsonPropertyName("unit_of_measurement")]
    public string? UnitOfMeasurement { get; set; }

    [JsonPropertyName("value_template")]
    public string ValueTemplate { get; set; } = "{{ value }}";
}
