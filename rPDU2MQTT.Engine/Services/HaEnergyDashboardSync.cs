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

    /// <summary>
    /// The energy-dashboard devices the current hierarchy + sensors map to. When <paramref name="existing"/>
    /// is supplied, a tier only counts as having a stat if that entity actually exists in HA — so tiers
    /// whose energy sensor hasn't been created (e.g. a PDU-level total) are skipped and their children link
    /// to the nearest ancestor that does exist, instead of producing an "entity not defined" in HA.
    /// </summary>
    public List<HaDeviceConsumption> BuildDevices(string energyType, ISet<string>? existing = null)
    {
        var merged = new PduData();
        foreach (var s in snapshots.All) merged.Devices.AddRange(s.Data.Devices);
        if (merged.Devices.Count == 0) return new();

        var baseResolver = BuildStatResolver(merged, energyType);
        Func<string, string?> resolver = existing is null
            ? baseResolver
            : id => baseResolver(id) is { } s && existing.Contains(s) ? s : null;

        var graph = FlowGraphBuilder.Build(merged, config.EnergyFlow, FlowGraphBuilder.DefaultMetric);
        return EnergyDashboardSync.BuildDeviceConsumption(graph, resolver);
    }

    /// <summary>Merge our hierarchy devices into HA's energy prefs (preserving the user's own). Returns the count synced.</summary>
    public async Task<int> SyncAsync(string url, string token, string energyType, CancellationToken ct)
    {
        using var ws = await ConnectAuth(url, token, ct);
        var call = Caller(ws, ct);

        var states = (await call("get_states", null))?["result"]?.AsArray() ?? new JsonArray();
        var existing = new HashSet<string>(
            states.Select(s => (string?)s?["entity_id"]).Where(e => !string.IsNullOrEmpty(e))!,
            StringComparer.OrdinalIgnoreCase);

        var devices = BuildDevices(energyType, existing);
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
