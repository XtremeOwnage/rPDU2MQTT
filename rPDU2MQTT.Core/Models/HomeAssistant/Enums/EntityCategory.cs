using rPDU2MQTT.Models.Converters;
using rPDU2MQTT.Models.HomeAssistant.Enums;
using System.Text.Json.Serialization;

/// <summary>
/// Represents the category of an entity in Home Assistant.
/// </summary>
/// <remarks>
/// An entity with a category will:
/// - Not be exposed to cloud, Alexa, or Google Assistant components.
/// - Not be included in indirect service calls to devices or areas.
/// </remarks>
public enum EntityCategory
{
    /// <summary>
    /// An entity that allows changing the configuration of a device.
    /// </summary>
    [JsonPropertyName("config")]
    Config,

    /// <summary>
    /// An entity exposing some configuration parameter or diagnostics of a device.
    /// </summary>
    [JsonPropertyName("diagnostic")]
    Diagnostic,
}