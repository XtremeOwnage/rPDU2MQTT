using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;

namespace rPDU2MQTT.Plugins;

/// <summary>Which plugins this host can load: a plugin is built against one version of <c>rPDU2MQTT.Core</c>.</summary>
/// <remarks>
/// Core's assembly version is the plugin API version. Same major, and a minor no newer than the host's.
/// Without this the host's Core is handed to any plugin, and a mismatch surfaces later as a missing method.
/// </remarks>
public static class PluginApi
{
    private const string CoreName = "rPDU2MQTT.Core";

    /// <summary>The API version this host provides.</summary>
    public static Version Host { get; } = typeof(Core.Integrations.IIntegration).Assembly.GetName().Version!;

    /// <summary>The Core version <paramref name="file"/> was built against, or null when it does not reference Core.</summary>
    public static Version? BuiltAgainst(string file)
    {
        using var stream = File.OpenRead(file);
        using var pe = new PEReader(stream);
        if (!pe.HasMetadata) return null;
        var md = pe.GetMetadataReader();
        foreach (var handle in md.AssemblyReferences)
        {
            var reference = md.GetAssemblyReference(handle);
            if (md.GetString(reference.Name) == CoreName) return reference.Version;
        }
        return null;
    }

    /// <summary>Null when a plugin built against <paramref name="built"/> can load here, otherwise why not.</summary>
    public static string? Incompatible(Version built, Version host)
    {
        if (built.Major != host.Major)
            return $"built for plugin API {Short(built)}, this bridge provides {Short(host)}. Rebuild it against this version.";
        if (built.Minor > host.Minor)
            return $"built for plugin API {Short(built)}, newer than this bridge's {Short(host)}. Update the bridge.";
        return null;
    }

    /// <summary><see cref="Incompatible(Version, Version)"/> for a file, against this host.</summary>
    public static string? Incompatible(string file)
        => BuiltAgainst(file) is { } built ? Incompatible(built, Host) : null;

    private static string Short(Version v) => $"{v.Major}.{v.Minor}";
}
