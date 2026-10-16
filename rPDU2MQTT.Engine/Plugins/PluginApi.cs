using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;

namespace rPDU2MQTT.Plugins;

/// <summary>Plugin API compatibility: same Core major, minor no newer than the host's.</summary>
public static class PluginApi
{
    private const string CoreName = "rPDU2MQTT.Core";

    public static Version Host { get; } = typeof(Core.Integrations.IIntegration).Assembly.GetName().Version!;

    /// <summary>Referenced Core version, or null.</summary>
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

    /// <summary>Null if compatible, otherwise the reason.</summary>
    public static string? Incompatible(Version built, Version host)
    {
        if (built.Major != host.Major)
            return $"built for plugin API {Short(built)}, this bridge provides {Short(host)}. Rebuild it against this version.";
        if (built.Minor > host.Minor)
            return $"built for plugin API {Short(built)}, newer than this bridge's {Short(host)}. Update the bridge.";
        return null;
    }

    public static string? Incompatible(string file)
        => BuiltAgainst(file) is { } built ? Incompatible(built, Host) : null;

    private static string Short(Version v) => $"{v.Major}.{v.Minor}";
}
