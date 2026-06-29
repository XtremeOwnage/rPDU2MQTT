using Microsoft.Extensions.Configuration;
using rPDU2MQTT.Core;

namespace rPDU2MQTT.Startup;

public static class HostRoles
{
    /// <summary>
    /// Resolve the active role(s) from <c>--role</c> (command line) or <c>RPDU2MQTT_ROLE</c> (env),
    /// accepting a comma/space/semicolon-separated list (e.g. <c>api,ui</c>). Unset or unrecognised
    /// falls back to <see cref="HostRole.All"/> so a plain install just runs everything.
    /// </summary>
    public static HostRole Resolve(IConfiguration config)
    {
        var raw = config["role"] ?? config["RPDU2MQTT_ROLE"];
        if (string.IsNullOrWhiteSpace(raw)) return HostRole.All;

        var roles = HostRole.None;
        foreach (var token in raw.Split(new[] { ',', ' ', ';' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            roles |= token.ToLowerInvariant() switch
            {
                "all" => HostRole.All,
                "worker" or "engine" or "data" => HostRole.Worker,
                "api" => HostRole.Api,
                "ui" or "gui" or "web" => HostRole.Ui,
                _ => HostRole.None,
            };

        return roles == HostRole.None ? HostRole.All : roles;
    }
}
