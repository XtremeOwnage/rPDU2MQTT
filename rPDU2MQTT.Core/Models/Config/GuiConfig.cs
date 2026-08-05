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
    [NotEditableInGui("Turning the GUI off from inside the GUI would lock you out of the only place you could turn it back on. Set it where the deployment is defined — the Helm values, the container environment, or config.yaml.")]
    [Description("Enable the embedded configuration web GUI.")]
    [FeatureToggle]
    public bool Enabled { get; set; }

    /// <summary>Show the link back to the project's GitHub page in the GUI footer.</summary>
    [DefaultValue(true)]
    [Description("Show a link to the project's GitHub page in the GUI. Turn off for a cleaner look on a shared screen.")]
    public bool ShowProjectLink { get; set; } = true;

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
