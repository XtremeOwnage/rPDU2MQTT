using rPDU2MQTT.Models.Config.Schemas;
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
    public Schemas.Credentials? Credentials { get; set; } = null;

    /// <summary>
    /// Gets or sets the polling interval for the PDU in seconds.
    /// </summary>
    [Range(1, int.MaxValue, ErrorMessage = "PollInterval must be greater than 0.")]
    [Display(Description = "The polling interval for the PDU in seconds.")]
    public int PollInterval { get; set; } = 5;

    [Range(1, 60 * 10, ErrorMessage = "Expected timeout between 1 second, and 10 minutes.")]
    [Display(Description = "Http timeout for requests to PDU")]
    public int Timeout { get; set; } = 5;

    [YamlMember(Alias = "Actions", DefaultValuesHandling = DefaultValuesHandling.OmitNull, Description = "Configuration to enable write actions via PDU")]
    public ActionsConfig? Actions { get; set; } = null;
}