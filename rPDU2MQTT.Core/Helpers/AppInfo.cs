using System.Reflection;

namespace rPDU2MQTT.Helpers;

/// <summary>
/// Application identity injected at build time. The version string is stamped into the
/// assembly's <see cref="AssemblyInformationalVersionAttribute"/> by the build
/// (<c>/p:InformationalVersion=...</c>); see the Dockerfile and the Docker publish workflow.
/// For releases this is a clean semver (e.g. <c>1.2.3</c>); for dev builds it is a traceable
/// pre-release string (e.g. <c>0.0.0-main.42+abc1234</c>) that maps back to a branch and run.
/// </summary>
public static class AppInfo
{
    /// <summary>
    /// Human-readable application version. Prefers the informational version (which can carry
    /// pre-release / build metadata) and falls back to the numeric assembly version, then
    /// <c>"unknown"</c>.
    /// </summary>
    public static string Version { get; } = ResolveVersion();

    private static string ResolveVersion()
    {
        var asm = Assembly.GetEntryAssembly() ?? typeof(AppInfo).Assembly;

        var informational = asm.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
        if (!string.IsNullOrWhiteSpace(informational))
        {
            // The SDK may append the source revision as "+<sha>"; keep our own metadata but
            // drop an auto-appended commit hash we didn't ask for so the string stays clean.
            return informational;
        }

        return asm.GetName().Version?.ToString() ?? "unknown";
    }
}
