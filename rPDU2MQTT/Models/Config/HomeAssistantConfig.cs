namespace rPDU2MQTT.Models.Config;
#nullable disable

/// <summary>
/// Configuration settings for Home Assistant integration.
/// </summary>
public class HomeAssistantConfig
{
    /// <summary>
    /// Gets or sets a value indicating whether Home Assistant discovery is enabled.
    /// </summary>
    [Display(Description = "Indicates whether Home Assistant discovery is enabled.")]
    public bool DiscoveryEnabled { get; set; } = false;

    /// <summary>
    /// Gets or sets the discovery topic for Home Assistant.
    /// </summary>
    [Display(Description = "The discovery topic for Home Assistant.")]
    public string DiscoveryTopic { get; set; }

    /// <summary>
    /// How often should discovery data be published?
    /// </summary>
    public int DiscoveryInterval { get; set; }

    /// <summary>
    ///  Default expireAfter interval applied to all sensors. After this time- the sensor will be marked as unavailable.
    /// </summary>
    public int SensorExpireAfterSeconds { get; set; } = (int)TimeSpan.FromMinutes(5).TotalSeconds;
}