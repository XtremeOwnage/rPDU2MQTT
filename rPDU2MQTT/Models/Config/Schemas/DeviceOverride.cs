using YamlDotNet.Serialization;

namespace rPDU2MQTT.Models.Config.Schemas;
/// <summary>
/// This represents device-level overrides.
/// </summary>
public class DeviceOverride : EntityOverride
{

    [YamlMember(Alias = "Outlets", DefaultValuesHandling = DefaultValuesHandling.OmitNull, Description = "Allows overriding values for individual outlets.")]
    public Dictionary<int, EntityOverride?> Outlets { get; set; } = new();
}
