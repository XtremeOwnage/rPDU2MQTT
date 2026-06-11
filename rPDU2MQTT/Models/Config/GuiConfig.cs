using System.ComponentModel;
using YamlDotNet.Serialization;

namespace rPDU2MQTT.Models.Config;

/// <summary>
/// Configuration for the optional embedded web GUI used to view, edit and test the configuration.
/// </summary>
public class GuiConfig
{
    [DefaultValue(false)]
    [Description("Enable the embedded configuration web GUI.")]
    public bool Enabled { get; set; }

    [DefaultValue(8080)]
    [Description("Port the configuration GUI listens on.")]
    public int Port { get; set; } = 8080;

    [Description("Username required to access the GUI (HTTP Basic auth).")]
    public string Username { get; set; } = "admin";

    [YamlMember(DefaultValuesHandling = DefaultValuesHandling.OmitNull)]
    [Description("Password required to access the GUI. The GUI refuses to start until this is set.")]
    public string? Password { get; set; }
}
