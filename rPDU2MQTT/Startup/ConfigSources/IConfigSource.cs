using rPDU2MQTT.Classes;

namespace rPDU2MQTT.Startup.ConfigSources;

/// <summary>
/// Where the configuration is read from (and written back to). Today: a YAML file or a Kubernetes
/// RpduConfig custom resource. Selected at startup by <see cref="ConfigSourceFactory"/>.
/// </summary>
public interface IConfigSource
{
    /// <summary>Human-readable description of the source (shown in the GUI/logs).</summary>
    string Describe { get; }

    /// <summary>Whether <see cref="SaveAsync"/> can persist changes (e.g. false for a read-only mount).</summary>
    bool CanWrite { get; }

    /// <summary>True for sources backed by a GitOps-managed object (the GUI warns about drift on save).</summary>
    bool IsGitOpsManaged { get; }

    /// <summary>Read and fully initialize the current configuration.</summary>
    Config Load();

    /// <summary>Persist the configuration back to the source.</summary>
    Task SaveAsync(Config config, CancellationToken cancellationToken);
}
