using System.Text.Json.Serialization;

namespace rPDU2MQTT.Interfaces;
/// <summary>
/// This type, stores its expected MQTT Key.
/// </summary>
public interface IMQTTKey
{
    /// <summary>
    /// This device / entities MQTT Topic Key.
    /// </summary>
    [JsonIgnore]
    public string Record_Key { get; }

    /// <summary>
    /// Unique identifier for this particular device / entity.
    /// </summary>
    [JsonIgnore]
    public string Entity_Identifier { get; }

    /// <summary>
    /// Contains parent for this record.
    /// </summary>
    [JsonIgnore]
    public IMQTTKey? Record_Parent { get; }
}
