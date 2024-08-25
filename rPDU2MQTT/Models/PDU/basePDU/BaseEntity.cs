using rPDU2MQTT.Extensions;
using rPDU2MQTT.Interfaces;
using System.Text.Json.Serialization;

namespace rPDU2MQTT.Models.PDU.DummyDevices;


/// <param name="Record_Key">This record's MQTT Topic Key.</param>
/// <param name="UniqueIdentifier">A unique identifer for this particular entity.</param>
/// <param name="Record_Parent">This record's parent.</param>
public class BaseEntity : IMQTTKey
{
    protected BaseEntity() { }
    public static DummyEntity FromDevice(IMQTTKey Parent, MqttPath Path)
    {
        return new DummyEntity
        {
            Record_Key = Path.ToJsonString(),
            Record_Parent = Parent,
            Entity_Identifier = Parent.CreateChildIdentifier(Path.ToJsonString())
        };
    }
    #region IMQTTKey

    /// <inheritdoc cref="IMQTTKey.Entity_Identifier"/>
    /// <remarks>
    /// This should only bet set by <see cref="Classes.PDU"/>
    /// </remarks>
    [JsonIgnore]
    public string Entity_Identifier { get; set; }

    /// <inheritdoc cref="IMQTTKey.Record_Key"/>
    /// <remarks>
    /// This should only bet set by <see cref="Classes.PDU"/>
    /// </remarks>
    [JsonIgnore]
    public string Record_Key { get; set; }

    /// <inheritdoc cref="IMQTTKey.Record_Parent"/>
    /// <remarks>
    /// This should only bet set by <see cref="Classes.PDU"/>
    /// </remarks>
    [JsonIgnore]
    public IMQTTKey? Record_Parent { get; set; }
    #endregion

}