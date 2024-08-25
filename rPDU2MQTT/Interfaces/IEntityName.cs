namespace rPDU2MQTT.Interfaces;

/// <summary>
/// This record stores its own entity name.
/// </summary>
public interface IEntityName
{
    /// <summary>
    /// Should contain a "formatted" name, which can be used as an entity name via Home Assistant, etc.
    /// </summary>
    public string Entity_Name { get; set; }

    /// <summary>
    /// This can contain the full, friendly name for an entity.
    /// </summary>
    public string Entity_DisplayName { get; set; }
}
