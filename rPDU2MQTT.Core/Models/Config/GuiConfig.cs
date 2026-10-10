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

    /// <summary>Show the documentation and GitHub links in the GUI footer.</summary>
    [DefaultValue(true)]
    [Description("Show links to the documentation and the GitHub page in the GUI. Turn off for a cleaner look on a shared screen.")]
    public bool ShowProjectLink { get; set; } = true;

    [DefaultValue("auto")]
    [AllowedValues("auto", "imperial", "metric")]
    [Description("How distances and sizes are shown on the floor plans: imperial (feet and inches), metric (metres and centimetres), or auto to follow the browser's language.")]
    public string DistanceUnits { get; set; } = "auto";

    [DefaultValue("auto")]
    [AllowedValues("auto", "celsius", "fahrenheit")]
    [Description("How temperatures are shown: celsius, fahrenheit, or auto to follow the browser's language.")]
    public string TemperatureUnits { get; set; } = "auto";

    [Display(Name = "Price per kWh")]
    [Description("What a kWh of energy costs, in your currency. When set, the Trends pages can chart energy as cost. Leave blank to not offer cost.")]
    public double? EnergyPrice { get; set; }

    [DefaultValue("$")]
    [Description("The currency symbol cost is shown with, e.g. $, €, £.")]
    public string Currency { get; set; } = "$";

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
