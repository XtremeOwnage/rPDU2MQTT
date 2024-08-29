namespace rPDU2MQTT.Models.Config;
#nullable disable

/// <summary>
/// Configuration settings for the PDU.
/// </summary>
public class PduConfig
{
    /// <summary>
    /// Gets or sets the device ID of the PDU.
    /// </summary>
    [Required(ErrorMessage = "DeviceId is required.")]
    [Display(Description = "The device ID of the PDU.")]
    public string DeviceId { get; set; }

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
}