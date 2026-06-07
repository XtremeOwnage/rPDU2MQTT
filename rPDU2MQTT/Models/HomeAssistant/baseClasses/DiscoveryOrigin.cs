using System.Reflection;
using System.Text.Json.Serialization;

namespace rPDU2MQTT.Models.HomeAssistant.baseClasses;

/// <summary>
/// Identifies the application publishing the discovery (Home Assistant "origin" object).
/// </summary>
public class DiscoveryOrigin
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = "rPDU2MQTT";

    [JsonPropertyName("sw_version")]
    public string? SoftwareVersion { get; set; }

    [JsonPropertyName("support_url")]
    public string? SupportUrl { get; set; }

    /// <summary>Shared origin describing this application.</summary>
    public static readonly DiscoveryOrigin Default = new()
    {
        Name = "rPDU2MQTT",
        SoftwareVersion = Assembly.GetEntryAssembly()?.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
            ?? Assembly.GetEntryAssembly()?.GetName().Version?.ToString(),
        SupportUrl = "https://github.com/XtremeOwnage/rPDU2MQTT"
    };
}
