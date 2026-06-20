using System.ComponentModel;
using YamlDotNet.Serialization;

namespace rPDU2MQTT.Models.Config;

/// <summary>
/// OpenID Connect (SSO) settings for the embedded GUI. When enabled, the GUI authenticates users
/// against an identity provider instead of HTTP Basic auth.
/// </summary>
public class OidcConfig
{
    [DefaultValue(false)]
    [Description("Enable OpenID Connect (SSO) login for the GUI instead of HTTP Basic auth.")]
    public bool Enabled { get; set; }

    [Description("OIDC authority / issuer URL (e.g. https://keycloak.example.com/realms/home).")]
    public string? Authority { get; set; }

    [Description("OIDC client ID registered with your identity provider.")]
    public string? ClientId { get; set; }

    [YamlMember(DefaultValuesHandling = DefaultValuesHandling.OmitNull)]
    [Description("OIDC client secret. Prefer the RPDU2MQTT_OIDC_CLIENT_SECRET env var (or *_FILE secret).")]
    public string? ClientSecret { get; set; }

    [DefaultValue("openid profile email")]
    [Description("Space-separated scopes to request.")]
    public string Scopes { get; set; } = "openid profile email";

    [DefaultValue("/signin-oidc")]
    [Description("Redirect/callback path registered with the identity provider.")]
    public string CallbackPath { get; set; } = "/signin-oidc";
}
