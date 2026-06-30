using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Hosting;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Models.PDU;

namespace rPDU2MQTT.Services;

/// <summary>
/// Keeps Home Assistant's Energy-Dashboard "individual devices" in sync with the energy-flow hierarchy
/// (#128): each tier's energy stat with its upstream device (<c>included_in_stat</c>). This can only be set
/// through HA's WebSocket API (not MQTT discovery), so it needs a HA URL + long-lived access token. A no-op
/// unless <c>HomeAssistant.EnergyDashboard.Enabled</c> is set.
/// </summary>
public sealed class HaEnergyDashboardService : BackgroundService
{
    private readonly Config config;
    private readonly Core.ISnapshotCache snapshots;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public HaEnergyDashboardService(Config config, Core.ISnapshotCache snapshots)
    {
        this.config = config;
        this.snapshots = snapshots;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Reconcile periodically; HA only needs this when the hierarchy or available sensors change.
        var period = TimeSpan.FromSeconds(Math.Max(30, config.Primary.PollInterval * 4));
        using var timer = new PeriodicTimer(period);
        do
        {
            try { await ReconcileAsync(stoppingToken); }
            catch (OperationCanceledException) { return; }
            catch (Exception ex) { Log.Warning($"HA Energy Dashboard sync failed: {ex.Message}"); }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    private async Task ReconcileAsync(CancellationToken ct)
    {
        var ed = config.HASS.EnergyDashboard;
        if (!ed.Enabled || string.IsNullOrWhiteSpace(ed.Url) || string.IsNullOrWhiteSpace(ed.Token))
            return;

        // Build one graph across all fresh sources and a tier-id -> HA energy entity_id resolver.
        var merged = new PduData();
        foreach (var s in snapshots.All) merged.Devices.AddRange(s.Data.Devices);
        if (merged.Devices.Count == 0) return;

        var statFor = BuildStatResolver(merged, ed.EnergyMeasurementType);
        var graph = FlowGraphBuilder.Build(merged, config.EnergyFlow, FlowGraphBuilder.DefaultMetric);
        var desired = EnergyDashboardSync.BuildDeviceConsumption(graph, statFor);
        if (desired.Count == 0) return;

        await PushAsync(ed.Url!, ed.Token!, desired, ct);
    }

    // Map a flow tier id to its Home Assistant energy sensor entity_id (sensor.<object_id>), when the tier
    // has a measurement of the configured energy type. Covers PDU tiers (device-level entities) and outlets.
    private static Func<string, string?> BuildStatResolver(PduData data, string energyType)
    {
        var byNode = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        string? EnergyEntity(IEnumerable<Measurement> measurements) =>
            measurements.FirstOrDefault(m => string.Equals(m.Type, energyType, StringComparison.OrdinalIgnoreCase))?.Entity_Name is { Length: > 0 } name
                ? "sensor." + name
                : null;

        foreach (var device in data.Devices)
        {
            if (EnergyEntity(device.Entity.SelectMany(e => e.Measurements)) is { } pduStat)
                byNode[$"pdu:{device.Entity_Name}"] = pduStat;
            foreach (var outlet in device.Outlets)
                if (EnergyEntity(outlet.Measurements) is { } outletStat)
                    byNode[$"outlet:{device.Entity_Name}:{outlet.Key}"] = outletStat;
        }
        return id => byNode.TryGetValue(id, out var s) ? s : null;
    }

    private async Task PushAsync(string url, string token, List<HaDeviceConsumption> desired, CancellationToken ct)
    {
        var wsUrl = url.TrimEnd('/').Replace("https://", "wss://").Replace("http://", "ws://") + "/api/websocket";
        using var ws = new ClientWebSocket();
        await ws.ConnectAsync(new Uri(wsUrl), ct);

        await Receive(ws, ct);                                                    // auth_required
        await Send(ws, new { type = "auth", access_token = token }, ct);
        var auth = await Receive(ws, ct);
        if ((string?)auth?["type"] != "auth_ok")
            throw new Exception("Home Assistant rejected the access token.");

        await Send(ws, new { id = 1, type = "energy/get_prefs" }, ct);
        var prefs = (await Receive(ws, ct))?["result"]?.AsObject()
            ?? throw new Exception("Could not read HA energy preferences.");

        // Keep the user's own devices; replace only the ones whose stat we manage.
        var ours = desired.Select(d => d.stat_consumption).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var devices = new JsonArray();
        foreach (var existing in prefs["device_consumption"]?.AsArray() ?? new JsonArray())
            if (existing is JsonObject o && !ours.Contains((string?)o["stat_consumption"] ?? ""))
                devices.Add(JsonNode.Parse(o.ToJsonString())!);
        foreach (var d in desired)
            devices.Add(JsonSerializer.SerializeToNode(d, Json)!);
        prefs["device_consumption"] = devices;

        var save = JsonSerializer.SerializeToNode(new { id = 2, type = "energy/save_prefs" }, Json)!.AsObject();
        foreach (var kv in prefs) save[kv.Key] = kv.Value is null ? null : JsonNode.Parse(kv.Value.ToJsonString());
        await Send(ws, save, ct);
        var result = await Receive(ws, ct);
        if ((bool?)result?["success"] != true)
            throw new Exception($"HA save_prefs failed: {result?.ToJsonString()}");

        Log.Information($"HA Energy Dashboard: synced {desired.Count} hierarchy device(s).");
        await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, null, ct);
    }

    private static Task Send(ClientWebSocket ws, object message, CancellationToken ct)
        => ws.SendAsync(Encoding.UTF8.GetBytes(message is JsonNode n ? n.ToJsonString() : JsonSerializer.Serialize(message, Json)),
            WebSocketMessageType.Text, true, ct);

    private static async Task<JsonNode?> Receive(ClientWebSocket ws, CancellationToken ct)
    {
        var buffer = new ArraySegment<byte>(new byte[64 * 1024]);
        using var ms = new MemoryStream();
        WebSocketReceiveResult result;
        do
        {
            result = await ws.ReceiveAsync(buffer, ct);
            ms.Write(buffer.Array!, 0, result.Count);
        }
        while (!result.EndOfMessage);
        return JsonNode.Parse(Encoding.UTF8.GetString(ms.ToArray()));
    }
}
