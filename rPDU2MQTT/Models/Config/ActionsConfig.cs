using YamlDotNet.Serialization;

namespace rPDU2MQTT.Models.Config;

/// <summary>
/// Configuration settings for actions.
/// </summary>
public class ActionsConfig
{
    /// <summary>
    /// Gets or sets a value indicating whether actions are enabled.
    /// </summary>
    [Display(Description = "Indicates whether actions are enabled.")]
    public bool Enabled { get; set; } = false;



}