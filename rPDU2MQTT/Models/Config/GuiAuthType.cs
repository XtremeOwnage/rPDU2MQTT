namespace rPDU2MQTT.Models.Config;

/// <summary>How the embedded GUI authenticates users.</summary>
public enum GuiAuthType
{
    /// <summary>HTTP Basic auth against Gui.Username / Gui.Password.</summary>
    Basic,

    /// <summary>OpenID Connect (SSO) via Gui.Oidc.</summary>
    Oidc,

    /// <summary>No authentication (anyone who can reach the port has full access).</summary>
    None,
}
