using System.Diagnostics;

namespace rPDU2MQTT.Plugins;

/// <summary>A plugin found at startup, loaded or not.</summary>
/// <param name="Key">The name <c>DisabledPlugins</c> matches.</param>
/// <param name="Name">The assembly's title.</param>
/// <param name="Integrations">Ids of the integrations it contributed.</param>
public sealed record PluginInfo(string Key, string Name, string? Version, bool Bundled, bool Disabled,
                                IReadOnlyList<string> Integrations, string? Error);

/// <summary>Every plugin found at startup.</summary>
public sealed class PluginCatalog
{
    public PluginCatalog(IEnumerable<LoadedPlugin> found)
        => Plugins = found.GroupBy(p => p.Key, StringComparer.OrdinalIgnoreCase)
                          .Select(g => Describe(g.Key, g.ToList()))
                          .OrderBy(p => p.Name, StringComparer.OrdinalIgnoreCase)
                          .ToList();

    public IReadOnlyList<PluginInfo> Plugins { get; }

    private static PluginInfo Describe(string key, List<LoadedPlugin> files)
    {
        var main = files.FirstOrDefault(f => f.Integrations.Count > 0) ?? files[0];
        // Read from the file's version resource; the assembly is not loaded.
        var info = File.Exists(main.File) ? FileVersionInfo.GetVersionInfo(main.File) : null;
        var name = main.Integrations.Count > 0
            ? string.Join(", ", main.Integrations.Select(i => i.DisplayName))
            : info?.FileDescription is { Length: > 0 } d && d != Path.GetFileNameWithoutExtension(main.File) ? d : key;
        return new PluginInfo(key, name, info?.ProductVersion?.Split('+')[0], main.Bundled, main.Disabled,
                              files.SelectMany(f => f.Integrations).Select(i => i.Id).ToList(),
                              files.Select(f => f.Error).FirstOrDefault(e => e is not null));
    }
}
