using Microsoft.Extensions.Configuration;

namespace rPDU2MQTT.Startup;

/// <summary>
/// Which workload(s) this process runs. The components live in one solution and one executable; the
/// active role(s) decide which hosted services start. Default is <see cref="All"/> — a single node that
/// does everything — but the same binary can run a single role per process to scale out (e.g. several
/// <see cref="Worker"/>s behind one <see cref="Ui"/>). Cross-role communication is in-process today;
/// a message-bus transport (the existing MQTT broker) is the planned seam for a distributed deployment.
/// </summary>
[Flags]
public enum HostRole
{
    None = 0,
    /// <summary>Automation / data processing: PDU pollers, MQTT publish, exporters, discovery, control.</summary>
    Worker = 1,
    /// <summary>Middle tier: the read-only REST API.</summary>
    Api = 2,
    /// <summary>The configuration GUI.</summary>
    Ui = 4,
    All = Worker | Api | Ui,
}

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
