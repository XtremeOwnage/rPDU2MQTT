using YamlDotNet.Serialization;

namespace rPDU2MQTT.Models.Config.Schemas;

/// <summary>
/// Oneview Group-specific overrides.
/// </summary>
public class OneviewGroupOverrides
{
    [YamlMember(Alias = "Measurements", DefaultValuesHandling = DefaultValuesHandling.OmitNull, Description = "Allows overriding individual measurements for groups")]
    public Dictionary<string, EntityOverride?> Measurements { get; set; } = new();
}
