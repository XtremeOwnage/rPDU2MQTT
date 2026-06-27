using System.ComponentModel;
using System.ComponentModel.DataAnnotations;
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

    [DefaultValue(GuiAuthType.Basic)]
    [Display(Name = "Authentication")]
    [Description("How users authenticate to the GUI: Basic (username/password), Oidc (SSO), or None (no login).")]
    public GuiAuthType AuthType { get; set; } = GuiAuthType.Basic;

    [DefaultValue(8080)]
    [Description("Port the configuration GUI listens on.")]
    public int Port { get; set; } = 8080;

    [Description("Username required to access the GUI (HTTP Basic auth).")]
    public string Username { get; set; } = "admin";

    [YamlMember(DefaultValuesHandling = DefaultValuesHandling.OmitNull)]
    [Description("Password required to access the GUI (HTTP Basic auth). Required unless Oidc is enabled.")]
    public string? Password { get; set; }

    [Description("OpenID Connect (SSO) settings (used when AuthType is Oidc).")]
    public OidcConfig Oidc { get; set; } = new();
}
