using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Models.PDU;

namespace rPDU2MQTT.Services;

/// <summary>
/// Talks to Home Assistant's Energy-Dashboard preferences over its WebSocket API (#128): builds the
/// device hierarchy from the energy flow + current PDU data, and pushes/clears it. Shared by the periodic
/// <see cref="HaEnergyDashboardService"/> and the GUI's manual sync/clear buttons.
/// </summary>
public sealed class HaEnergyDashboardSync
{
    private readonly Config config;
    private readonly Core.ISnapshotCache snapshots;
    private readonly Core.Flow.IFlowValueSource? live;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public HaEnergyDashboardSync(Config config, Core.ISnapshotCache snapshots, Core.Flow.IFlowValueSource? live = null)
    {
        this.config = config;
        this.snapshots = snapshots;
        this.live = live;
    }

    /// <summary>
    /// The energy-dashboard devices the current hierarchy maps to. Outlets and PDU tiers resolve to their
    /// native PDU-discovery energy sensor; the synthetic hierarchy tiers resolve to the energyflow sensor
    /// the flow export publishes (<c>energyflow_&lt;key&gt;_energy</c>) — this matches which records actually
    /// exist in HA (#177) and avoids the duplicates a uniform energyflow mapping caused. Everything is
    /// resolved through HA's authoritative <c>unique_id → entity_id</c> map, so we never guess an entity_id;
    /// tiers whose sensor isn't in HA are skipped and their children link to the nearest ancestor that is —
    /// giving HA the full Grid → Panel → Circuit → PDU → outlet chain.
    /// </summary>
    public List<HaDeviceConsumption> BuildDevices(IReadOnlyDictionary<string, string> entityByUniqueId)
    {
        var merged = new PduData();
        foreach (var s in snapshots.All) merged.Devices.AddRange(s.Data.Devices);
        if (merged.Devices.Count == 0) return new();

        var energyType = string.IsNullOrWhiteSpace(config.HASS.EnergyDashboard.EnergyMeasurementType) ? "energy" : config.HASS.EnergyDashboard.EnergyMeasurementType;
        var native = FlowExport.NativeEnergyUniqueIds(merged, energyType);

        var graph = FlowGraphBuilder.Build(merged, config.EnergyFlow, FlowGraphBuilder.DefaultMetric, live);
        Func<string, string?> resolver = id =>
        {
            var uid = native.TryGetValue(id, out var nativeUid) ? nativeUid : FlowExport.EnergyUniqueId(id);
            return entityByUniqueId.TryGetValue(uid, out var e) ? e : null;
        };
        return EnergyDashboardSync.BuildDeviceConsumption(graph, resolver);
    }

    /// <summary>Merge our hierarchy devices into HA's energy prefs (preserving the user's own). Returns the count synced.</summary>
    public async Task<int> SyncAsync(string url, string token, CancellationToken ct)
    {
        using var ws = await ConnectAuth(url, token, ct);
        var call = Caller(ws, ct);

        // HA's authoritative unique_id -> entity_id map, so we use real entity_ids (not guesses).
        var registry = (await call("config/entity_registry/list", null))?["result"]?.AsArray() ?? new JsonArray();
        var entityByUniqueId = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var e in registry)
            if ((string?)e?["unique_id"] is { Length: > 0 } uid && (string?)e?["entity_id"] is { Length: > 0 } eid)
                entityByUniqueId[uid] = eid;

        var devices = BuildDevices(entityByUniqueId);
        var prefs = (await call("energy/get_prefs", null))?["result"]?.AsObject()
            ?? throw new Exception("Could not read HA energy preferences.");

        var ours = devices.Select(d => d.stat_consumption).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var keep = new JsonArray();
        foreach (var existingDevice in prefs["device_consumption"]?.AsArray() ?? new JsonArray())
            if (existingDevice is JsonObject o && !ours.Contains((string?)o["stat_consumption"] ?? ""))
                keep.Add(o.DeepClone());
        foreach (var d in devices)
            keep.Add(JsonSerializer.SerializeToNode(d, Json)!);
        prefs["device_consumption"] = keep;

        await SavePrefs(call, prefs);
        return devices.Count;
    }

    /// <summary>Remove every device from HA's Energy-Dashboard device list. Returns how many were cleared.</summary>
    public async Task<int> ClearAsync(string url, string token, CancellationToken ct)
    {
        using var ws = await ConnectAuth(url, token, ct);
        var call = Caller(ws, ct);

        var prefs = (await call("energy/get_prefs", null))?["result"]?.AsObject()
            ?? throw new Exception("Could not read HA energy preferences.");
        var cleared = prefs["device_consumption"]?.AsArray()?.Count ?? 0;
        prefs["device_consumption"] = new JsonArray();

        await SavePrefs(call, prefs);
        return cleared;
    }

    private static async Task SavePrefs(Func<string, JsonObject?, Task<JsonNode?>> call, JsonObject prefs)
    {
        var body = new JsonObject();
        foreach (var kv in prefs) body[kv.Key] = kv.Value?.DeepClone();
        var result = await call("energy/save_prefs", body);
        if ((bool?)result?["success"] != true)
            throw new Exception($"HA save_prefs failed: {result?["error"]?["message"] ?? result?.ToJsonString()}");
    }

    private static async Task<ClientWebSocket> ConnectAuth(string url, string token, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(url) || string.IsNullOrWhiteSpace(token))
            throw new Exception("Home Assistant URL and access token are required.");

        var wsUrl = url.TrimEnd('/').Replace("https://", "wss://").Replace("http://", "ws://") + "/api/websocket";
        var ws = new ClientWebSocket();
        try
        {
            await ws.ConnectAsync(new Uri(wsUrl), ct);
            await Receive(ws, ct);                                                  // auth_required
            await Send(ws, new { type = "auth", access_token = token }, ct);
            if ((string?)(await Receive(ws, ct))?["type"] != "auth_ok")
                throw new Exception("Home Assistant rejected the access token.");
            return ws;
        }
        catch { ws.Dispose(); throw; }
    }

    // A sequential command caller: {id, type, ...extra} -> the next message (its result). HA isn't
    // subscribed to events here, so the reply to each command is the next frame.
    private static Func<string, JsonObject?, Task<JsonNode?>> Caller(ClientWebSocket ws, CancellationToken ct)
    {
        var nextId = 1;
        return async (type, extra) =>
        {
            var msg = new JsonObject { ["id"] = nextId++, ["type"] = type };
            if (extra is not null) foreach (var kv in extra) msg[kv.Key] = kv.Value?.DeepClone();
            await Send(ws, msg, ct);
            return await Receive(ws, ct);
        };
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
