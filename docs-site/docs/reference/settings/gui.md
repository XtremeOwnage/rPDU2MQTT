---
title: GUI
---

# GUI

Generated from `rPDU2MQTT --emit-schema`. Keys are case-insensitive. `[]` marks a list item and `<name>` a map key of your choosing. A blank default means none is declared.

Embedded configuration web GUI

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `Gui` | object |  | Embedded configuration web GUI |
| `Gui.Enabled` | bool | `false` | Enable the embedded configuration web GUI. |
| `Gui.ShowProjectLink` | bool | `true` | Show links to the documentation and the GitHub page in the GUI. Turn off for a cleaner look on a shared screen. |
| `Gui.DistanceUnits` | one of `auto`, `imperial`, `metric` | `auto` | How distances and sizes are shown on the floor plans: imperial (feet and inches), metric (metres and centimetres), or auto to follow the browser's language. |
| `Gui.EnergyPrice` | double |  | What a kWh of energy costs, in your currency. When set, the Trends pages can chart energy as cost. Leave blank to not offer cost. |
| `Gui.Currency` | string | `$` | The currency symbol cost is shown with, e.g. $, €, £. |
| `Gui.AuthType` | one of `Basic`, `Oidc`, `None` | `Basic` | How users authenticate to the GUI: Basic (username/password), Oidc (SSO), or None (no login). |
| `Gui.Port` | int | `8080` | Port the configuration GUI listens on. |
| `Gui.Username` | string |  | Username required to access the GUI (HTTP Basic auth). |
| `Gui.Password` | string (secret) |  | Password required to access the GUI (HTTP Basic auth). Required unless Oidc is enabled. |
| `Gui.Oidc` | object |  | OpenID Connect (SSO) settings (used when AuthType is Oidc). |
| `Gui.Oidc.Authority` | string |  | OIDC authority / issuer URL (e.g. https://keycloak.example.com/realms/home). |
| `Gui.Oidc.ClientId` | string |  | OIDC client ID registered with your identity provider. |
| `Gui.Oidc.ClientSecret` | string (secret) |  | OIDC client secret. Prefer the RPDU2MQTT_OIDC_CLIENT_SECRET env var (or *_FILE secret). |
| `Gui.Oidc.Scopes` | string | `openid profile email` | Space-separated scopes to request. |
| `Gui.Oidc.CallbackPath` | string | `/signin-oidc` | Redirect/callback path registered with the identity provider. |
