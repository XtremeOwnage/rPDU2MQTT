using System.Collections.Concurrent;

namespace rPDU2MQTT.Core.Startup;

/// <summary>One optional feature that is switched on but cannot run as configured.</summary>
/// <param name="Component">Status-board component id, e.g. "emoncms".</param>
/// <param name="Path">The config path at fault, e.g. "EmonCMS.Url".</param>
/// <param name="Message">What to do about it, in the operator's terms.</param>
public sealed record ConfigurationFault(string Component, string Path, string Message);

/// <summary>
/// Optional features that were enabled but are missing something they need.
///
/// <para>
/// These used to throw during startup, which meant a single toggle in the GUI — "EmonCMS: on", before
/// filling in the URL — left the process unable to start at all. Everything else the bridge does (polling
/// the PDU, publishing to MQTT, Home Assistant discovery, the energy flow) died with it, and the only
/// clue was a stack trace in a container that was already restarting.
/// </para>
/// <para>
/// Nothing reachable from a toggle may stop the bridge starting. An optional destination that cannot run
/// is switched off, recorded here, logged as an error, and shown on the Status board — loud and
/// diagnosable rather than fatal. Anything genuinely required to do the job at all (the MQTT broker, a
/// PDU host) still fails fast; that is not a state a toggle can produce.
/// </para>
/// </summary>
public sealed class ConfigurationFaults
{
    private readonly ConcurrentDictionary<string, ConfigurationFault> faults = new(StringComparer.OrdinalIgnoreCase);

    public void Record(ConfigurationFault fault) => faults[fault.Component] = fault;

    /// <summary>The fault for a component, or null when it is fine.</summary>
    public ConfigurationFault? For(string component)
        => faults.TryGetValue(component, out var f) ? f : null;

    public IReadOnlyCollection<ConfigurationFault> All => faults.Values.ToList();
}

/// <summary>
/// Whether an optional feature has what it needs. Pure, so the rules are testable without building a host.
///
/// <para>
/// Only the logging sinks are left here. A destination's own requirements moved onto
/// <c>IIntegration.Misconfigured</c> when destinations became plugins: the rule belongs with the thing it
/// is about, an externally loaded plugin has no way to add a method to this class, and a copy kept here
/// would be a second answer to the same question — one of which nothing calls.
/// </para>
/// </summary>
public static class DestinationRequirements
{
    /// <summary>File logging needs somewhere to write.</summary>
    public static ConfigurationFault? FileLog(bool enabled, string? path)
    {
        if (!enabled || !string.IsNullOrWhiteSpace(path)) return null;
        return new ConfigurationFault("logging.file", "Logging.File.Path",
            "File logging is enabled but Logging.File.Path is not set. Logging to file is disabled; the console sink is unaffected.");
    }

    /// <summary>Syslog needs a host to send to.</summary>
    public static ConfigurationFault? Syslog(bool enabled, string? host)
    {
        if (!enabled || !string.IsNullOrWhiteSpace(host)) return null;
        return new ConfigurationFault("logging.syslog", "Logging.Syslog.Host",
            "Syslog logging is enabled but Logging.Syslog.Host is not set. Syslog is disabled; other log sinks are unaffected.");
    }
}
