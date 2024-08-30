using YamlDotNet.Serialization;

namespace rPDU2MQTT.Models.Config.Schemas;

/// <summary>
/// This defines the schema for overrides for a specific type of entity.
/// </summary>
/// <typeparam name="string">This is the type of key used.</typeparam>
public class EntityOverride
{
    /// <summary>
    /// Allows overriding the generated EntityName.
    /// </summary>
    /// <remarks>
    /// This maps to <see cref="HomeAssistant.baseClasses.baseEntity.Name"/>, ie, "object_id"
    /// </remarks>
    [YamlMember(Alias = "ID", DefaultValuesHandling = DefaultValuesHandling.OmitNull, Description = "Overridden ID")]
    public string? ID { get; set; }

    /// <summary>
    /// Allows overriding the Name / Display Name.
    /// </summary>
    /// <remarks>
    /// This maps to <see cref="HomeAssistant.baseClasses.baseEntity.DisplayName"/>, ie, "name"
    /// </remarks>
    [YamlMember(Alias = "Name", DefaultValuesHandling = DefaultValuesHandling.OmitNull, Description = "Overridden Name")]
    public string? Name { get; set; }

    /// <summary>
    /// Should this entity be enabled, or disabled?
    /// </summary>
    /// <remarks>
    /// Disabled entities will not be published.
    /// </remarks>
    [YamlMember(Alias = "Enabled", DefaultValuesHandling = DefaultValuesHandling.OmitNull, Description = "Is this entity enabled?")]
    public bool Enabled { get; set; } = true;
}
