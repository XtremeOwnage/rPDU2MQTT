namespace rPDU2MQTT.Models.Config;

/// <summary>
/// Configuration settings for the MQTT broker.
/// </summary>
public class MQTTConfig
{
    /// <summary>
    /// Gets or sets the username for connecting to the MQTT broker.
    /// </summary>
    [Display(Description = "The username for connecting to the MQTT broker.")]
    public string? Username { get; set; } = null;

    /// <summary>
    /// Gets or sets the password for connecting to the MQTT broker.
    /// </summary>
    [Display(Description = "The password for connecting to the MQTT broker.")]
    public string? Password { get; set; } = null;

    /// <summary>
    /// Gets or sets the client-id for connecting to the MQTT broker.
    /// </summary>
    [Display(Description = "The client-id used when connecting to MQTT.")]
    public string ClientID { get; set; } = "rpdu2mqtt";

    /// <summary>
    /// Gets or sets the parent topic for MQTT messages.
    /// </summary>
    [Required(ErrorMessage = "ParentTopic is required.")]
    [Display(Description = "The parent topic for MQTT messages.")]
    public string ParentTopic { get; set; } = "Rack_PDU";

    /// <summary>
    /// Gets or sets the host of the MQTT broker.
    /// </summary>
    [Required(ErrorMessage = "Host is required.")]
    [Display(Description = "The host of the MQTT broker.")]
    public string Host { get; set; } = "localhost";

    /// <summary>
    /// Gets or sets the port of the MQTT broker.
    /// </summary>
    [Range(0, 65535, ErrorMessage = "Port must be between 0 and 65535.")]
    [Display(Description = "The port of the MQTT broker.")]
    public int Port { get; set; } = 1883;

    /// <summary>
    /// Gets or sets the keepalive interval for the MQTT connection in seconds.
    /// </summary>
    [Range(1, int.MaxValue, ErrorMessage = "KeepAlive must be greater than 0.")]
    [Display(Description = "The keepalive interval for the MQTT connection in seconds.")]
    public int KeepAlive { get; set; } = 60;
}
