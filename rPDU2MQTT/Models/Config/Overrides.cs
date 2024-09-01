using rPDU2MQTT.Models.Config.Schemas;
using YamlDotNet.Serialization;

namespace rPDU2MQTT.Models.Config;

[YamlSerializable]
public class Overrides
{
    [YamlMember(Alias = "PDU", DefaultValuesHandling = DefaultValuesHandling.OmitNull, Description = "Allows overriding values for the PDU itself.")]
    public EntityOverride PDU { get; set; } = new();


    [YamlMember(Alias = "Devices", DefaultValuesHandling = DefaultValuesHandling.OmitNull, Description = "Allows overriding configuration for individual devices.")]
    public Dictionary<string, EntityOverride?> Devices { get; set; } = new();


    [YamlMember(Alias = "Outlets", DefaultValuesHandling = DefaultValuesHandling.OmitNull, Description = "Allows overriding values for individual outlets.")]
    public Dictionary<int, EntityOverride?> Outlets { get; set; } = new();


    [YamlMember(Alias = "Measurements", DefaultValuesHandling = DefaultValuesHandling.OmitNull, Description = "Allows overriding individual measurements")]
    public Dictionary<string, EntityOverride?> Measurements { get; set; } = new();
}
