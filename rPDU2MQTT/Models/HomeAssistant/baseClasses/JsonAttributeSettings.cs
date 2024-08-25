using rPDU2MQTT.Models.Converters;
using System.Text.Json.Serialization;

namespace rPDU2MQTT.Models.HomeAssistant.baseClasses;

/// <summary>
/// This class holds properties used to pull and populate JSON Attributes for entities.
/// </summary>
public class JsonAttributeSettings
{
    /// <summary>
    /// Defines a template to extract the JSON dictionary from messages received on the json_attributes_topic.
    /// </summary>
    [JsonPropertyName("json_attributes_template")]
    public string? JsonAttributesTemplate { get; set; }

    /// <summary>
    /// The MQTT topic subscribed to receive a JSON dictionary payload and then set as sensor attributes.
    /// </summary>
    [JsonPropertyName("json_attributes_topic")]
    public string? JsonAttributesTopic { get; set; }
}
