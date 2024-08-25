using rPDU2MQTT.Interfaces;
using System.Text.Json.Serialization;

namespace rPDU2MQTT.Models.PDU.DummyDevices;

/// <summary>
/// Represents an entity which has a name, which will be used when building discoveries, etc.
/// </summary>
/// <remarks>
/// Does NOT mean the data published has a name!
/// </remarks>
public class NamedEntity : BaseEntity, IEntityName
{
    [JsonIgnore]
    /// <inheritdoc cref="IEntityName.Name"/>
    public string Entity_Name { get; set; }

    [JsonIgnore]
    /// <inheritdoc cref="IEntityName.DisplayName"/>
    public string Entity_DisplayName { get; set; }
}
