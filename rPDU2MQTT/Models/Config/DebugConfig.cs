using System.ComponentModel;
using YamlDotNet.Serialization;

namespace rPDU2MQTT.Models.Config;

/// <summary>
/// Settings for debugging and diagnostics.
/// </summary>
public class DebugConfig
{
    /// <summary>
    /// This- determines if messages are actually PUSHED to the MQTT broker.
    /// </summary>
    /// <remarks>
    /// Intended usage, is to allow the entire process to be tested, and debugged, without actually publishing the mwssages.
    /// </remarks>
    [YamlMember(Alias = "PublishMessages")]
    [DefaultValue(true)]
    public bool PublishMessages { get; set; } = true;


    /// <summary>
    /// When enabled, this will print the MQTT discovery messages to the console.
    /// </summary>
    [YamlMember(Alias = "PrintDiscovery")]
    [DefaultValue(false)]
    public bool PrintDiscovery { get; set; } = false;
}