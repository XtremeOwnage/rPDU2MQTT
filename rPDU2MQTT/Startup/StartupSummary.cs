using rPDU2MQTT.Classes;
using rPDU2MQTT.Core;
using rPDU2MQTT.Helpers;
using rPDU2MQTT.Startup.ConfigSources;

namespace rPDU2MQTT.Startup;

/// <summary>
/// Says what this process decided to be, once, at startup.
/// <para>
/// Everything here is a decision made from config that otherwise leaves no trace: which roles this process
/// runs, where its config came from, which PDUs and Modbus devices it will talk to, how big the energy-flow
/// graph is, and which integrations are switched on. Without it, a process that silently does nothing looks
/// exactly like a process that's working — the log's first job is to make that distinguishable.
/// </para>
/// </summary>
public static class StartupSummary
{
    public static void Log(Config cfg, HostRole roles, IConfigSource source)
    {
        var roleNames = new[] { HostRole.Worker, HostRole.Api, HostRole.Ui, HostRole.Operator }
            .Where(r => roles.HasFlag(r))
            .Select(r => r.ToString().ToLowerInvariant())
            .ToArray();

        Serilog.Log.Information("rPDU2MQTT {Version} starting as {Roles} — config from {ConfigSource}.",
            AppInfo.Version, roleNames.Length == 0 ? "all" : string.Join("+", roleNames), source.Describe);

        // Sources.
        foreach (var (id, pdu) in cfg.Pdus)
            Serilog.Log.Information("  PDU '{Instance}' at {Host} every {Interval}s (writes {Writes}).",
                id, pdu.Connection?.Host ?? "?", pdu.PollInterval, pdu.ActionsEnabled ? "enabled" : "disabled");
        if (cfg.Pdus.Count == 0)
            Serilog.Log.Warning("  No PDU instances configured.");

        var modbus = cfg.Modbus?.Connections?.Count ?? 0;
        if (modbus > 0) Serilog.Log.Information("  Modbus: {Count} connection(s).", modbus);

        var nodes = cfg.EnergyFlow?.Nodes?.Count ?? 0;
        var links = cfg.EnergyFlow?.Links?.Count ?? 0;
        var bindings = cfg.EnergyFlow?.Nodes?.Sum(n => n.AllSources().Count()) ?? 0;
        if (nodes > 0)
            Serilog.Log.Information("  Energy flow: {Nodes} node(s), {Links} link(s), {Bindings} live binding(s).", nodes, links, bindings);

        // Destinations — each one is a thing someone will wonder why isn't updating.
        Serilog.Log.Information("  MQTT → {Host}:{Port} under '{Topic}'.",
            cfg.MQTT.Connection?.Host ?? "?", cfg.MQTT.Connection?.Port ?? 0, cfg.MQTT.ParentTopic);
        Serilog.Log.Information("  Home Assistant discovery: {State}{Topic}",
            cfg.HASS.DiscoveryEnabled ? "on" : "off", cfg.HASS.DiscoveryEnabled ? $" → '{cfg.HASS.DiscoveryTopic}'" : "");
        Serilog.Log.Information("  Energy dashboard sync: {State}.", cfg.HASS.EnergyDashboard?.Enabled == true ? "on" : "off");
        Serilog.Log.Information("  Prometheus exporter: {State}{Port}",
            cfg.Prometheus.Exporter ? "on" : "off", cfg.Prometheus.Exporter ? $" → :{cfg.Prometheus.Port}/metrics" : "");
        Serilog.Log.Information("  EmonCMS: {State}{Detail}",
            cfg.EmonCMS.Enabled ? "on" : "off",
            cfg.EmonCMS.Enabled ? $" via {cfg.EmonCMS.Transport} (feeds auto-configure {(cfg.EmonCMS.Feeds.AutoConfigure ? "on" : "off")})" : "");
        Serilog.Log.Information("  GUI: {State}.", cfg.Gui.Enabled ? $"on :{cfg.Gui.Port}" : "off");

        // How to see more, said once, where someone reading the log will find it.
        Serilog.Log.Information("  Console log level is {Level}; set Logging.Console.Severity to Debug or Verbose for the detail behind each poll, publish and grain call.",
            cfg.Logging.Console.Severity);
    }
}
