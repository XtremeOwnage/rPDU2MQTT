using rPDU2MQTT.Interfaces;
using System.Diagnostics;
using System.Text.Json.Serialization;

namespace rPDU2MQTT.Models.PDU.DummyDevices;

[DebuggerDisplay("{Entity_Name}")]
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

    /// <summary>Optional Manufacturer/Model overrides (from config), surfaced in HA discovery.</summary>
    [JsonIgnore]
    public string? Entity_Make { get; set; }

    [JsonIgnore]
    public string? Entity_Model { get; set; }
}
