using System.Text.Json.Serialization;
using rPDU2MQTT.Interfaces;
using rPDU2MQTT.Models.Converters;
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
[JsonPolymorphic(IgnoreUnrecognizedTypeDiscriminators = false, TypeDiscriminatorPropertyName = nameof(JsonPolyMorphicTypeName), UnknownDerivedTypeHandling = JsonUnknownDerivedTypeHandling.FallBackToNearestAncestor)]
public abstract class baseEntity : IBaseDiscovery
{
    [JsonIgnore]
    public string JsonPolyMorphicTypeName { get; set; }
    /// <summary>
    /// Sub-class to hold topics relating to availability.
    /// </summary>
    /// <remarks>
    /// If, this is not <see langword="null"/>, its properties will be flattened onto the parent object.
    /// </remarks>
    [JsonConverter(typeof(FlattenNullableObjectToParentObjectConverter))]
    public EntityAvailability? Availability { get; set; } = null;

    /// <summary>
    /// Sub-class which holds properties related to JSON Attributes.
    /// </summary>
    /// <remarks>
    /// If, this is not <see langword="null"/>, its properties will be flattened onto the parent object.
    /// </remarks>
    [JsonConverter(typeof(FlattenNullableObjectToParentObjectConverter))]
    public JsonAttributeSettings? JsonAttributes { get; set; } = null;

    [JsonIgnore(Condition = JsonIgnoreCondition.Always)]
    /// <summary>
    /// This is the type of entity this object represents.
    /// </summary>
    /// <remarks>
    /// Note- this is not serialized here.
    /// </remarks>
    public virtual EntityType EntityType { get; set; }

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
    /// This is the device for which this entity will belong to.
    /// </summary>
    [JsonPropertyName("device")]
    public required DiscoveryDevice Device { get; init; }

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
