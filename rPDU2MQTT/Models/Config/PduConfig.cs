namespace rPDU2MQTT.Models.Config;
#nullable disable

/// <summary>
/// Configuration settings for the PDU.
/// </summary>
public class PduConfig
{
    /// <summary>
    /// Gets or sets the URL of the PDU API.
    /// </summary>
    [Required(ErrorMessage = "Url is required.")]
    [Url(ErrorMessage = "Url must be a valid URL.")]
    [Display(Description = "The URL of the PDU API.")]
    public string Url { get; set; }

    /// <summary>
    /// Gets or sets the polling interval for the PDU in seconds.
    /// </summary>
    [Range(1, int.MaxValue, ErrorMessage = "PollInterval must be greater than 0.")]
    [Display(Description = "The polling interval for the PDU in seconds.")]
    public int PollInterval { get; set; } = 5;

    [Range(1, 60 * 10, ErrorMessage = "Expected timeout between 1 second, and 10 minutes.")]
    [Display(Description = "Http timeout for requests to PDU")]
    public int Timeout { get; set; } = 5;
}