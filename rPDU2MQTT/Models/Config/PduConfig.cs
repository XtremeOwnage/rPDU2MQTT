using rPDU2MQTT.Models.Config.Schemas;
using System.ComponentModel;
using YamlDotNet.Serialization;

namespace rPDU2MQTT.Models.Config;

/// <summary>
/// Configuration settings for the PDU.
/// </summary>
public class PduConfig
{
    /// <summary>
    /// Gets or sets the connection details for MQTT Broker.
    /// </summary>
    [Required(ErrorMessage = "Connection is required")]
    [Display(Description = "Connection details for PDU")]
    public Connection Connection { get; set; } = new Connection();

    /// <summary>
    /// Credentials used when connection to PDU.
    /// </summary>
    [YamlMember(Alias = "Credentials", DefaultValuesHandling = DefaultValuesHandling.OmitNull)]
    [DefaultValue(null)]
    public Schemas.Credentials? Credentials { get; set; } = null;

    /// <summary>
    /// Gets or sets the polling interval for the PDU in seconds.
    /// </summary>
    [Range(1, int.MaxValue, ErrorMessage = "PollInterval must be greater than 0.")]
    [Display(Description = "The polling interval for the PDU in seconds.")]
    [DefaultValue(5)]
    public int PollInterval { get; set; } = 5;

    [DefaultValue(false)]
    [YamlMember(Alias = "ActionsEnabled", DefaultValuesHandling = DefaultValuesHandling.OmitNull, Description = "Configuration to enable write actions via PDU")]
    /// <summary>
    /// Gets or sets a value indicating whether actions are enabled.
    /// </summary>
    [Display(Description = "Indicates whether actions are enabled.")]
    public bool ActionsEnabled { get; set; }
}