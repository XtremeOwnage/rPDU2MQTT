using System.ComponentModel;

namespace rPDU2MQTT.Models.Config.Schemas;

/// <summary>
/// This defines the schema used for credentials.
/// </summary>
public class Credentials
{
    [Description("Username to log in as")]
    public string? Username { get; set; }

    [Description("Password to login with")]
    public string? Password { get; set; }
}
