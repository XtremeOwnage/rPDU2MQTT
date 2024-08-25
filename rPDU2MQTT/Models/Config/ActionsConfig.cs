namespace rPDU2MQTT.Models.Config;
#nullable disable

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

    /// <summary>
    /// Gets or sets the username for performing actions.
    /// </summary>
    [Display(Description = "The username for performing actions.")]
    public string Username { get; set; }

    /// <summary>
    /// Gets or sets the password for performing actions.
    /// </summary>
    [Display(Description = "The password for performing actions.")]
    public string Password { get; set; }
}