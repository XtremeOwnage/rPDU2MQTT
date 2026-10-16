using System.Diagnostics;

namespace rPDU2MQTT.Plugins;

/// <summary>A plugin found at startup, loaded or not.</summary>
/// <param name="Key">The name <c>DisabledPlugins</c> matches.</param>
/// <param name="Name">The assembly's title.</param>
/// <param name="Description">The assembly's description.</param>
/// <param name="Integrations">Ids of the integrations it contributed.</param>
/// <param name="Capabilities">What its integrations do between them: destination, history, values, …</param>
public sealed record PluginInfo(string Key, string Name, string? Version, bool Bundled, bool Disabled,
                                IReadOnlyList<string> Integrations, string? Error,
                                string? Description = null, IReadOnlyList<string>? Capabilities = null);

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
        var title = info?.FileDescription is { Length: > 0 } d && d != Path.GetFileNameWithoutExtension(main.File) ? d : null;
        var name = title ?? (main.Integrations.Count > 0 ? string.Join(", ", main.Integrations.Select(i => i.DisplayName)) : key);
        var integrations = files.SelectMany(f => f.Integrations).ToList();
        return new PluginInfo(key, name, info?.ProductVersion?.Split('+')[0], main.Bundled, main.Disabled,
                              integrations.Select(i => i.Id).ToList(),
                              files.Select(f => f.Error).FirstOrDefault(e => e is not null),
                              info?.Comments is { Length: > 0 } c ? c : null,
                              integrations.SelectMany(Core.Integrations.IntegrationRegistry.Capabilities).Distinct().ToList());
    }
}
