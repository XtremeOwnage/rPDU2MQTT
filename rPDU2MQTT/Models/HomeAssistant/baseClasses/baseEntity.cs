using System.Text.Json.Serialization;
using rPDU2MQTT.Extensions;
using rPDU2MQTT.Interfaces;
using rPDU2MQTT.Models.HomeAssistant.DiscoveryTypes;
using rPDU2MQTT.Models.HomeAssistant.Enums;
using rPDU2MQTT.Models.HomeAssistant.Interfaces;

namespace rPDU2MQTT.Models.HomeAssistant.baseClasses;

/// <summary>
/// Represents a base entity, for discovery.
/// </summary>
/// 

// System.Text.Json is dumb.... has must have these derrived types annotated here.
// Otherwise, It does not serialize the properties of derrived classes.
// Why didn't I just use Newtonsoft.
[JsonDerivedType(typeof(baseSensorEntity))]
[JsonDerivedType(typeof(BinarySensorDiscovery))]
[JsonDerivedType(typeof(SensorDiscovery))]
[JsonDerivedType(typeof(SwitchDiscovery))]
[JsonDerivedType(typeof(ButtonDiscovery))]
[JsonPolymorphic(IgnoreUnrecognizedTypeDiscriminators = false, TypeDiscriminatorPropertyName = nameof(JsonPolyMorphicTypeName), UnknownDerivedTypeHandling = JsonUnknownDerivedTypeHandling.FallBackToNearestAncestor)]
public abstract class baseEntity : IBaseDiscovery
{
    [JsonIgnore]
    public string JsonPolyMorphicTypeName { get; set; }
    #region Availability
    /// <summary>
    /// Topic carrying the bridge's online/offline status (its MQTT birth/LWT message).
    /// </summary>
    [JsonPropertyName("availability_topic")]
    public string? AvailabilityTopic { get; set; }

    [JsonPropertyName("payload_available")]
    public string? PayloadAvailable { get; set; } = "online";

    [JsonPropertyName("payload_not_available")]
    public string? PayloadNotAvailable { get; set; } = "offline";
    #endregion

    [JsonIgnore(Condition = JsonIgnoreCondition.Always)]
    /// <summary>
    /// This is the type of entity this object represents.
    /// </summary>
    public virtual EntityType EntityType { get; set; }

    /// <summary>
    /// The component platform (domain) this entity maps to, used in device-based discovery.
    /// </summary>
    [JsonPropertyName("platform")]
    public string Platform => EntityType.ToJsonString();

    /// <summary>
    /// The category of the entity. When set, the entity category must be diagnostic for sensors.
    /// </summary>
    [JsonPropertyName("entity_category")]
    public virtual EntityCategory? EntityCategory { get; set; } = null;

    [JsonPropertyName("state_topic")]
    public string StateTopic { get; set; }

    #region Identifying Details
    /// <summary>
    /// This is a unique identifier for each object. Must be unique!
    /// </summary>
    [JsonPropertyName("unique_id")]
    public string ID { get; set; }

    /// <inheritdoc cref="IBaseDiscovery.Name"/>>
    [JsonPropertyName("object_id")]
    public string Name { get; set; }

    /// <summary>
    /// This is the partial "Friendly" name which users will see.
    /// </summary>
    [JsonPropertyName("name")]
    public string DisplayName { get; set; }
    #endregion

    /// <summary>
    /// The device this entity belongs to. Used to group entities into a single device-based
    /// discovery payload; the device block itself is published once at the payload root.
    /// </summary>
    [JsonIgnore]
    public DiscoveryDevice Device { get; init; } = null!;

    /// <summary>
    /// Icon for the entity.
    /// </summary>
    [JsonPropertyName("icon")]
    public string? Icon { get; set; }

    /// <summary>
    /// Flag which defines if the entity should be enabled when first added.
    /// </summary>
    [JsonPropertyName("enabled_by_default")]
    public bool? EnabledByDefault { get; set; } = true;
}
