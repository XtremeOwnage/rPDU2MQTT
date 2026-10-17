using System.ComponentModel;
using HiveMQtt.Client;
using ModelContextProtocol.Server;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Helpers;
using rPDU2MQTT.Models.Config;
using static rPDU2MQTT.Services.ApiService;

namespace rPDU2MQTT.Services;

/// <summary>
/// The read-only MCP tools served at <c>/mcp</c>. Mirrors the <c>/api/v1</c> reads, plus the status board
/// and history, which the REST API does not expose. Nothing here can change state.
/// </summary>
[McpServerToolType]
public sealed class McpTools(
    Config cfg, Core.Integrations.IPduInstances registry, ISnapshotCache snapshots, HealthState health, IHiveMQClient mqtt,
    IFlowValueSource? live, Core.Status.StatusBoard? status, IMeasurementHistory? history)
{
    [McpServerTool(Name = "list_instances", ReadOnly = true, Idempotent = true, OpenWorld = false)]
    [Description("List the configured PDU instances: id, whether it is the primary, host, poll interval and whether outlet actions are enabled.")]
    public List<InstanceDto> ListInstances() =>
        cfg.Pdus.Select(kv => new InstanceDto(
            kv.Key,
            string.Equals(kv.Key, registry.PrimaryId, StringComparison.OrdinalIgnoreCase),
            kv.Value.Connection?.Host,
            kv.Value.PollInterval,
            kv.Value.ActionsEnabled)).ToList();

    [McpServerTool(Name = "get_health", ReadOnly = true, Idempotent = true, OpenWorld = false)]
    [Description("Bridge liveness: start time, uptime, MQTT connectivity and the last successful poll.")]
    public HealthDto GetHealth() =>
        new(health.StartedUtc, (long)health.Uptime.TotalSeconds, mqtt.IsConnected(), health.LastPollUtc);

    [McpServerTool(Name = "get_status", ReadOnly = true, Idempotent = true, OpenWorld = false)]
    [Description("The Status board: every component (broker, devices, integrations, history, storage) with its level (Good/Warn/Bad/Off), state and detail. Use this to find what is failing.")]
    public IReadOnlyList<Core.Status.ComponentStatus> GetStatus() => status?.Board() ?? [];

    [McpServerTool(Name = "list_snapshots", ReadOnly = true, Idempotent = true, OpenWorld = false)]
    [Description("Latest snapshot timestamp and age in seconds per PDU instance. A large age means polling has stalled.")]
    public List<SnapshotDto> ListSnapshots()
    {
        var now = DateTime.UtcNow;
        return snapshots.All
            .Select(s => new SnapshotDto(s.InstanceId, s.TimestampUtc, (now - s.TimestampUtc).TotalSeconds))
            .OrderBy(s => s.InstanceId)
            .ToList();
    }

    [McpServerTool(Name = "get_readings", ReadOnly = true, Idempotent = true, OpenWorld = false)]
    [Description("Current measurements (power, current, voltage, energy, temperature...) for every device, outlet and sensor in the latest snapshot.")]
    public List<ReadingDto> GetReadings(
        [Description("PDU instance id to limit results to. Omit for all instances.")] string? instance = null,
        [Description("Only readings whose device, source or type contains this text (case-insensitive), e.g. an outlet name or 'realpower'.")] string? filter = null)
    {
        var sources = string.IsNullOrEmpty(instance)
            ? snapshots.All
            : snapshots.All.Where(s => string.Equals(s.InstanceId, instance, StringComparison.OrdinalIgnoreCase));

        return sources
            .SelectMany(s => MetricsHelper.EnumerateReadings(s.Data)
                .Select(r => new ReadingDto(s.InstanceId, r.Device, r.Source, r.Type, r.Value, r.Units)))
            .Where(r => string.IsNullOrEmpty(filter)
                || r.Device.Contains(filter, StringComparison.OrdinalIgnoreCase)
                || r.Source.Contains(filter, StringComparison.OrdinalIgnoreCase)
                || r.Type.Contains(filter, StringComparison.OrdinalIgnoreCase))
            .OrderBy(r => r.InstanceId).ThenBy(r => r.Device).ThenBy(r => r.Source).ThenBy(r => r.Type)
            .ToList();
    }

    [McpServerTool(Name = "get_flow", ReadOnly = true, Idempotent = true, OpenWorld = false)]
    [Description("The energy/power flow graph: nodes (grid, solar, battery, panels, circuits, PDUs, outlets, virtual loads) with their values, and the links between them. Node ids from here are what get_history takes.")]
    public object GetFlow(
        [Description("PDU instance id. Omit for the latest snapshot.")] string? instance = null,
        [Description("Metric to weigh the graph by, e.g. realpower (default), energy_d, current.")] string? metric = null)
    {
        var snap = string.IsNullOrEmpty(instance) ? snapshots.Latest : snapshots.Get(instance);
        if (snap is null)
            return new { ok = false, message = "No snapshot available yet for that instance." };

        return FlowGraphBuilder.Build(snap.Data, cfg.EnergyFlow, string.IsNullOrEmpty(metric) ? FlowGraphBuilder.DefaultMetric : metric, live);
    }

    [McpServerTool(Name = "get_history", ReadOnly = true, Idempotent = true, OpenWorld = false)]
    [Description("Past readings for flow nodes from the configured history backend, one value per interval. Requires History to be enabled.")]
    public async Task<object> GetHistory(
        [Description("Flow node ids, as returned by get_flow (e.g. outlet:rack_pdu_1:3).")] string[] nodeIds,
        [Description("Metric, e.g. realpower (default).")] string? metric = null,
        [Description("How far back to read, in hours. Default 24, max 2160 (90 days).")] double hours = 24,
        [Description("Seconds between returned values. Default picks about 100 points.")] int? intervalSeconds = null,
        CancellationToken ct = default)
    {
        if (history is null || !cfg.History.Enabled)
            return new { ok = false, message = "History is not enabled on this bridge." };
        if (nodeIds is not { Length: > 0 })
            return new { ok = false, message = "Pass at least one node id (see get_flow)." };

        hours = Math.Clamp(hours, 0.1, 2160);
        var to = DateTime.UtcNow;
        var from = to.AddHours(-hours);
        // Floor the step so a long range cannot fan out into thousands of backend reads.
        var step = Math.Max(intervalSeconds ?? 0, (int)Math.Ceiling(hours * 3600 / 500));
        if (intervalSeconds is null) step = Math.Max(step, (int)Math.Ceiling(hours * 3600 / 100));

        var found = await history.ReadingsAsync(nodeIds, string.IsNullOrEmpty(metric) ? FlowGraphBuilder.DefaultMetric : metric, from, to, step, ct);
        return new
        {
            ok = true,
            backend = history.Id,
            fromUtc = from,
            toUtc = to,
            intervalSeconds = step,
            series = found.ToDictionary(kv => kv.Key, kv => kv.Value.Select(p => new { at = p.At, value = p.Value }).ToList()),
        };
    }
}
