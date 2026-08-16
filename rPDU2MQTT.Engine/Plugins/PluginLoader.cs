using System.Reflection;
using System.Runtime.Loader;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Integrations;

namespace rPDU2MQTT.Plugins;

/// <summary>A plugin assembly that was found, and what came out of it.</summary>
/// <param name="File">The assembly's path, as reported on the Status board.</param>
/// <param name="Integrations">The integrations it contributed, empty when it contributed none.</param>
/// <param name="Error">Why it could not be loaded, or null.</param>
public sealed record LoadedPlugin(string File, IReadOnlyList<IIntegration> Integrations, string? Error = null);

/// <summary>
/// Loads integrations from assemblies dropped into a plugins directory.
///
/// <para>
/// Writing one is: reference <c>rPDU2MQTT.Core</c>, implement <see cref="IIntegration"/> and whichever
/// capabilities apply, drop the DLL in <c>plugins/</c>. Core is the whole SDK — it carries the contracts,
/// the config model, the flow engine and the helpers, and it references no Orleans, no ASP.NET and no MQTT
/// client, so a plugin inherits none of those either.
/// </para>
/// <para>
/// What a runtime plugin gets for free, because both are generated rather than compiled: a rendered
/// settings page (the GUI's form is drawn from a schema built by reflection at startup) and its actions on
/// the API (routes are derived from the capabilities it declares). What it does not get is a place in the
/// Kubernetes CRD — that is a compile-time contract published to the API server, and it cannot describe a
/// type that exists only on one operator's machine. Under Kubernetes, plugin settings live in the
/// <c>Plugins</c> map, which the CRD leaves open.
/// </para>
/// </summary>
public static class PluginLoader
{
    /// <summary>Where plugins live, unless <c>RPDU2MQTT_PLUGINS</c> says otherwise.</summary>
    public static string DefaultDirectory =>
        Environment.GetEnvironmentVariable("RPDU2MQTT_PLUGINS") is { Length: > 0 } dir
            ? dir
            : Path.Combine(AppContext.BaseDirectory, "plugins");

    /// <summary>
    /// Load every plugin in <paramref name="directory"/>. Never throws: a plugin that will not load is
    /// reported and skipped, because a third-party DLL must not be able to stop the bridge starting.
    /// </summary>
    public static IReadOnlyList<LoadedPlugin> Load(string? directory = null, Action<string>? log = null)
    {
        var dir = directory ?? DefaultDirectory;
        if (!Directory.Exists(dir)) return Array.Empty<LoadedPlugin>();

        var found = new List<LoadedPlugin>();
        foreach (var file in Directory.EnumerateFiles(dir, "*.dll", SearchOption.AllDirectories).OrderBy(f => f))
        {
            try
            {
                var assembly = new PluginLoadContext(file).LoadFromAssemblyPath(Path.GetFullPath(file));
                var integrations = new List<IIntegration>();

                foreach (var type in assembly.GetTypes().Where(t => t is { IsClass: true, IsAbstract: false })
                                             .Where(typeof(IIntegration).IsAssignableFrom))
                {
                    // A plugin is constructed with no arguments on purpose: it is handed its settings
                    // through IConfigurablePlugin instead. Taking a constructor dependency would mean a
                    // plugin binding against this build's internals, which is exactly what it must not do.
                    if (Activator.CreateInstance(type) is IIntegration integration)
                        integrations.Add(integration);
                }

                if (integrations.Count == 0) continue;   // a dependency, not a plugin
                found.Add(new LoadedPlugin(file, integrations));
                log?.Invoke($"Plugin loaded: {Path.GetFileName(file)} — {string.Join(", ", integrations.Select(i => i.Id))}.");
            }
            catch (ReflectionTypeLoadException ex)
            {
                var why = string.Join("; ", ex.LoaderExceptions.Where(e => e is not null).Select(e => e!.Message).Distinct().Take(3));
                found.Add(new LoadedPlugin(file, Array.Empty<IIntegration>(), why));
                log?.Invoke($"Plugin '{Path.GetFileName(file)}' could not be loaded: {why}. It is being skipped; everything else starts as normal.");
            }
            catch (Exception ex)
            {
                found.Add(new LoadedPlugin(file, Array.Empty<IIntegration>(), ex.Message));
                log?.Invoke($"Plugin '{Path.GetFileName(file)}' could not be loaded: {ex.Message}. It is being skipped; everything else starts as normal.");
            }
        }
        return found;
    }

    /// <summary>
    /// Bind each loaded plugin to its settings from <paramref name="cfg"/>, writing a default section back
    /// for any that has never been configured so an operator has something to edit in the GUI.
    /// </summary>
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

/// <summary>
/// One load context per plugin, so two plugins can depend on different versions of the same library
/// without one of them silently getting the other's.
/// </summary>
/// <remarks>
/// Types the host already has — <c>IIntegration</c> and everything else in Core — deliberately resolve to
/// the <i>host's</i> copy rather than a private one. A plugin that loaded its own <c>rPDU2MQTT.Core</c>
/// would implement an interface that is not, as far as the runtime is concerned, the same interface, and
/// the cast would fail with a message nobody could act on.
/// </remarks>
internal sealed class PluginLoadContext : AssemblyLoadContext
{
    private readonly AssemblyDependencyResolver resolver;

    public PluginLoadContext(string pluginPath) : base(isCollectible: false)
        => resolver = new AssemblyDependencyResolver(pluginPath);

    protected override Assembly? Load(AssemblyName name)
    {
        // Anything already loaded by the host wins, so the contract types are shared.
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
