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
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public HaEnergyDashboardSync(Config config, Core.ISnapshotCache snapshots)
    {
        this.config = config;
        this.snapshots = snapshots;
    }

    /// <summary>The energy-dashboard devices the current hierarchy + sensors would map to.</summary>
    public List<HaDeviceConsumption> BuildDevices(string energyType)
    {
        var merged = new PduData();
        foreach (var s in snapshots.All) merged.Devices.AddRange(s.Data.Devices);
        if (merged.Devices.Count == 0) return new();

        var statFor = BuildStatResolver(merged, energyType);
        var graph = FlowGraphBuilder.Build(merged, config.EnergyFlow, FlowGraphBuilder.DefaultMetric);
        return EnergyDashboardSync.BuildDeviceConsumption(graph, statFor);
    }

    /// <summary>Merge our hierarchy devices into HA's energy prefs (preserving the user's own). Returns the count synced.</summary>
    public async Task<int> SyncAsync(string url, string token, string energyType, CancellationToken ct)
    {
        var devices = BuildDevices(energyType);
        await WithPrefs(url, token, ct, prefs =>
        {
            var ours = devices.Select(d => d.stat_consumption).ToHashSet(StringComparer.OrdinalIgnoreCase);
            var keep = new JsonArray();
            foreach (var existing in prefs["device_consumption"]?.AsArray() ?? new JsonArray())
                if (existing is JsonObject o && !ours.Contains((string?)o["stat_consumption"] ?? ""))
                    keep.Add(JsonNode.Parse(o.ToJsonString())!);
            foreach (var d in devices)
                keep.Add(JsonSerializer.SerializeToNode(d, Json)!);
            prefs["device_consumption"] = keep;
        });
        return devices.Count;
    }

    /// <summary>Remove every device from HA's Energy-Dashboard device list. Returns how many were cleared.</summary>
    public async Task<int> ClearAsync(string url, string token, CancellationToken ct)
    {
        var cleared = 0;
        await WithPrefs(url, token, ct, prefs =>
        {
            cleared = prefs["device_consumption"]?.AsArray()?.Count ?? 0;
            prefs["device_consumption"] = new JsonArray();
        });
        return cleared;
    }

    // Map a flow tier id to its HA energy sensor entity_id (sensor.<object_id>) when the tier has a
    // measurement of the configured energy type. Covers PDU tiers (device-level entities) and outlets.
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

    // Connect + auth, read energy/get_prefs, let the caller mutate it, then energy/save_prefs.
    private async Task WithPrefs(string url, string token, CancellationToken ct, Action<JsonObject> mutate)
    {
        if (string.IsNullOrWhiteSpace(url) || string.IsNullOrWhiteSpace(token))
            throw new Exception("Home Assistant URL and access token are required.");

        var wsUrl = url.TrimEnd('/').Replace("https://", "wss://").Replace("http://", "ws://") + "/api/websocket";
        using var ws = new ClientWebSocket();
        await ws.ConnectAsync(new Uri(wsUrl), ct);

        await Receive(ws, ct);                                                     // auth_required
        await Send(ws, new { type = "auth", access_token = token }, ct);
        if ((string?)(await Receive(ws, ct))?["type"] != "auth_ok")
            throw new Exception("Home Assistant rejected the access token.");

        await Send(ws, new { id = 1, type = "energy/get_prefs" }, ct);
        var prefs = (await Receive(ws, ct))?["result"]?.AsObject()
            ?? throw new Exception("Could not read HA energy preferences.");

        mutate(prefs);

        var save = JsonSerializer.SerializeToNode(new { id = 2, type = "energy/save_prefs" }, Json)!.AsObject();
        foreach (var kv in prefs) save[kv.Key] = kv.Value is null ? null : JsonNode.Parse(kv.Value.ToJsonString());
        await Send(ws, save, ct);
        var result = await Receive(ws, ct);
        if ((bool?)result?["success"] != true)
            throw new Exception($"HA save_prefs failed: {result?["error"]?["message"] ?? result?.ToJsonString()}");

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
