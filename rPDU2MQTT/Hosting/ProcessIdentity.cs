using rPDU2MQTT.Classes;
using rPDU2MQTT.Core;
using rPDU2MQTT.Helpers;

namespace rPDU2MQTT.Hosting;

/// <summary>
/// Who this process is, resolved once: its stable id, the roles it runs, the host/pod it's on, when it
/// started and which build. Shared by everything that reports on this process's behalf (the process registry
/// and the Status board), so a process can't appear under two identities.
/// </summary>
public sealed class ProcessIdentity
{
    public ProcessIdentity(HostRole roles, HealthState health)
    {
        Roles = new[] { HostRole.Worker, HostRole.Api, HostRole.Ui, HostRole.Operator }
            .Where(r => roles.HasFlag(r))
            .Select(r => r.ToString().ToLowerInvariant())
            .ToArray();

        Host = Environment.GetEnvironmentVariable("RPDU2MQTT_POD_NAME") ?? Environment.MachineName;
        StartedUtc = health.StartedUtc;

        var id = $"{string.Join('-', Roles)}-{Host}-{Guid.NewGuid():N}".ToLowerInvariant();
        Id = id.Length > 80 ? id[..80] : id;
    }

    public string Id { get; }
    public string[] Roles { get; }
    public string Host { get; }
    public DateTime StartedUtc { get; }
    public string Version => AppInfo.Version;

    /// <summary>The roles as the Status board says them — "worker, api, ui", or "all" for a single process.</summary>
    public string RoleLabel => Roles.Length == 0 ? "all" : string.Join(", ", Roles);
}
