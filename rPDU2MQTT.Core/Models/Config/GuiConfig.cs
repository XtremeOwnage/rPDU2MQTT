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

    [Display(Name = "Trusted networks")]
    [YamlMember(DefaultValuesHandling = DefaultValuesHandling.OmitEmptyCollections)]
    [Description("Addresses or CIDR ranges given read-only access without signing in, e.g. 10.100.64.247/32 for a wall display. Changes still need sign-in. Leave empty to require sign-in for everyone.")]
    public List<string> TrustedNetworks { get; set; } = new();

    [DefaultValue(true)]
    [Display(Name = "Kiosk authentication")]
    [Description("Require sign-in to open /kiosk. Off: anyone who can reach the GUI can open /kiosk, read-only.")]
    public bool KioskAuth { get; set; } = true;

    [Display(Name = "Trusted proxies")]
    [YamlMember(DefaultValuesHandling = DefaultValuesHandling.OmitEmptyCollections)]
    [Description("Addresses or CIDR ranges of reverse proxies whose X-Forwarded-For header is used to find the client address for Trusted networks. Leave empty to use the connecting address.")]
    public List<string> TrustedProxies { get; set; } = new();

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
