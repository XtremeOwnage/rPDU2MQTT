using System.Reflection;
using System.Runtime.Loader;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Integrations;

namespace rPDU2MQTT.Plugins;

/// <summary>A plugin assembly that was found, and what came out of it.</summary>
/// <param name="File">The assembly's path, as reported on the Status board.</param>
/// <param name="Integrations">The integrations it contributed, empty when it contributed none.</param>
/// <param name="Error">Why it could not be loaded, or null.</param>
/// <param name="Key">The folder or DLL name that <c>DisabledPlugins</c> matches.</param>
/// <param name="Bundled">Shipped with the bridge.</param>
/// <param name="Disabled">Skipped by <c>DisabledPlugins</c>; never loaded.</param>
public sealed record LoadedPlugin(string File, IReadOnlyList<IIntegration> Integrations, string? Error = null,
                                  string Key = "", bool Bundled = false, bool Disabled = false);

/// <summary>Loads integrations from plugin assemblies.</summary>
public static class PluginLoader
{
    /// <summary>Where plugins live, unless <c>RPDU2MQTT_PLUGINS</c> says otherwise.</summary>
    public static string DefaultDirectory =>
        Environment.GetEnvironmentVariable("RPDU2MQTT_PLUGINS") is { Length: > 0 } dir
            ? dir
            : Path.Combine(AppContext.BaseDirectory, "plugins");

    /// <summary>Plugins shipped with the bridge; not hidden by a volume over <see cref="DefaultDirectory"/>.</summary>
    public static string BundledDirectory => Path.Combine(AppContext.BaseDirectory, "bundled-plugins");

    /// <summary>External plugins, then bundled ones not already loaded from the external directory.</summary>
    /// <param name="disabled">Folder or DLL names to skip without loading.</param>
    public static IReadOnlyList<LoadedPlugin> LoadAll(IEnumerable<string>? disabled = null, Action<string>? log = null)
        => LoadAll(DefaultDirectory, BundledDirectory, disabled, log);

    internal static IReadOnlyList<LoadedPlugin> LoadAll(string externalDir, string bundledDir, IEnumerable<string>? disabled, Action<string>? log)
    {
        var off = new HashSet<string>(disabled ?? [], StringComparer.OrdinalIgnoreCase);
        var external = Units(externalDir).ToList();
        var names = external.SelectMany(u => u.Files).Select(Path.GetFileName).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var bundled = Units(bundledDir).Where(u => !u.Files.Any(f => names.Contains(Path.GetFileName(f))));
        return [.. external.SelectMany(u => LoadUnit(u, false, off, log)), .. bundled.SelectMany(u => LoadUnit(u, true, off, log))];
    }

    /// <summary>Load every plugin in <paramref name="directory"/>. Never throws; a bad plugin is reported and skipped.</summary>
    public static IReadOnlyList<LoadedPlugin> Load(string? directory = null, Action<string>? log = null)
        => Units(directory ?? DefaultDirectory).SelectMany(u => LoadUnit(u, false, new HashSet<string>(), log)).ToList();

    /// <summary>One switchable plugin: a loose DLL, or a folder and everything in it.</summary>
    private sealed record Unit(string Key, IReadOnlyList<string> Files);

    private static IEnumerable<Unit> Units(string dir)
    {
        if (!Directory.Exists(dir)) yield break;
        foreach (var file in Directory.EnumerateFiles(dir, "*.dll").OrderBy(f => f))
            yield return new(Path.GetFileNameWithoutExtension(file), [file]);
        foreach (var sub in Directory.EnumerateDirectories(dir).OrderBy(d => d))
        {
            var files = Directory.EnumerateFiles(sub, "*.dll", SearchOption.AllDirectories).OrderBy(f => f).ToList();
            if (files.Count > 0) yield return new(Path.GetFileName(sub), files);
        }
    }

    private static IEnumerable<LoadedPlugin> LoadUnit(Unit unit, bool bundled, ISet<string> off, Action<string>? log)
    {
        if (off.Contains(unit.Key))
        {
            log?.Invoke($"Plugin disabled: {unit.Key}.");
            return [new LoadedPlugin(MainFile(unit), [], Key: unit.Key, Bundled: bundled, Disabled: true)];
        }
        return unit.Files.Select(f => LoadFile(f, log)).OfType<LoadedPlugin>()
                   .Select(p => p with { Key = unit.Key, Bundled = bundled }).ToList();
    }

    // The assembly with a .deps.json is the plugin; the rest are its dependencies.
    private static string MainFile(Unit unit)
        => unit.Files.FirstOrDefault(f => File.Exists(Path.ChangeExtension(f, ".deps.json"))) ?? unit.Files[0];

    private static LoadedPlugin? LoadFile(string file, Action<string>? log)
    {
        try
        {
            var assembly = new PluginLoadContext(file).LoadFromAssemblyPath(Path.GetFullPath(file));
            var integrations = new List<IIntegration>();

            foreach (var type in assembly.GetTypes().Where(t => t is { IsClass: true, IsAbstract: false })
                                         .Where(typeof(IIntegration).IsAssignableFrom))
            {
                // Parameterless; settings arrive through IConfigurablePlugin.
                if (Activator.CreateInstance(type) is IIntegration integration)
                    integrations.Add(integration);
            }

            if (integrations.Count == 0) return null;   // a dependency, not a plugin
            log?.Invoke($"Plugin loaded: {Path.GetFileName(file)} — {string.Join(", ", integrations.Select(i => i.Id))}.");
            return new LoadedPlugin(file, integrations);
        }
        catch (ReflectionTypeLoadException ex)
        {
            var why = string.Join("; ", ex.LoaderExceptions.Where(e => e is not null).Select(e => e!.Message).Distinct().Take(3));
            log?.Invoke($"Plugin '{Path.GetFileName(file)}' could not be loaded: {why}. It is being skipped; everything else starts as normal.");
            return new LoadedPlugin(file, Array.Empty<IIntegration>(), why);
        }
        catch (Exception ex)
        {
            log?.Invoke($"Plugin '{Path.GetFileName(file)}' could not be loaded: {ex.Message}. It is being skipped; everything else starts as normal.");
            return new LoadedPlugin(file, Array.Empty<IIntegration>(), ex.Message);
        }
    }

    /// <summary>Bind each plugin to its settings, writing a default section for any not yet configured.</summary>
    public static void Configure(IEnumerable<IIntegration> plugins, Config cfg, Action<string>? warn = null)
    {
        foreach (var plugin in plugins.OfType<IConfigurablePlugin>())
        {
            var id = ((IIntegration)plugin).Id;
            var settings = PluginConfigBinder.Bind(plugin, id, cfg.Plugins!, warn);
            if (!cfg.Plugins.ContainsKey(id)) cfg.Plugins[id] = PluginConfigBinder.ToNode(settings);
        }
    }

    /// <summary>The plugin sections the GUI should render, for <c>ConfigSchema.Build(plugins)</c>.</summary>
    public static IEnumerable<(string Id, string Label, Type ConfigType, string? Group)> Sections(IEnumerable<IIntegration> plugins)
        => plugins.OfType<IConfigurablePlugin>()
                  .Select(p => (((IIntegration)p).Id, ((IIntegration)p).DisplayName, p.ConfigType,
                                (string?)((IIntegration)p).Group.ToString()));
}

/// <summary>One load context per plugin; assemblies the host already has resolve to the host's copy.</summary>
internal sealed class PluginLoadContext : AssemblyLoadContext
{
    private readonly AssemblyDependencyResolver resolver;

    public PluginLoadContext(string pluginPath) : base(isCollectible: false)
        => resolver = new AssemblyDependencyResolver(pluginPath);

    protected override Assembly? Load(AssemblyName name)
    {
        if (Default.Assemblies.FirstOrDefault(a => a.GetName().Name == name.Name) is { } shared) return shared;
        var path = resolver.ResolveAssemblyToPath(name);
        return path is null ? null : LoadFromAssemblyPath(path);
    }

    protected override IntPtr LoadUnmanagedDll(string name)
    {
        var path = resolver.ResolveUnmanagedDllToPath(name);
        return path is null ? IntPtr.Zero : LoadUnmanagedDllFromPath(path);
    }
}
