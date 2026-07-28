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
    /// <param name="excludeKinds">Node kinds to leave out; pass null to build the full set of tiers we manage
    /// (used by the sync to retire devices we exported before an exclusion was added).</param>
    public List<HaDeviceConsumption> BuildDevices(IReadOnlyDictionary<string, string> entityByUniqueId, IReadOnlyCollection<string>? excludeKinds)
    {
        var merged = new PduData();
        foreach (var s in snapshots.All) merged.Devices.AddRange(s.Data.Devices);
        if (merged.Devices.Count == 0) return new();

        var energyType = string.IsNullOrWhiteSpace(config.HASS.EnergyDashboard.EnergyMeasurementType) ? "energy" : config.HASS.EnergyDashboard.EnergyMeasurementType;
        var native = FlowExport.NativeEnergyUniqueIds(merged, energyType);

        var graph = FlowGraphBuilder.Build(merged, config.EnergyFlow, FlowGraphBuilder.DefaultMetric, live);
        var energyGraph = FlowGraphBuilder.Build(merged, config.EnergyFlow, energyType, live);
        Func<string, string?> resolver = id =>
        {
            // Only register a tier the bridge can actually give an energy (kWh) figure for. A node with no
            // energy behind it (power-only outlets, an unmeasured tier) would resolve to an entity HA then
            // marks "unavailable" — clutter, not data. Same never-fabricate rule as the diagram.
            if (!FlowExport.TryNodeValue(energyGraph, id, out _)) return null;
            var uid = native.TryGetValue(id, out var nativeUid) ? nativeUid : FlowExport.EnergyUniqueId(id);
            return entityByUniqueId.TryGetValue(uid, out var e) ? e : null;
        };
        return EnergyDashboardSync.BuildDeviceConsumption(graph, resolver, excludeKinds);
    }

    /// <summary>
    /// Every energy entity_id any flow tier maps to right now — ignoring the energy-known gate and the kind
    /// exclusion. This is the full set the sync "owns" and may remove: dropping it before re-adding the kept
    /// devices is what retires a tier once it's excluded (grid/battery/inverter) or once it stops being a
    /// device, without ever touching an entity the user added themselves.
    /// </summary>
    private HashSet<string> ManagedStats(IReadOnlyDictionary<string, string> entityByUniqueId)
    {
        var stats = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var merged = new PduData();
        foreach (var s in snapshots.All) merged.Devices.AddRange(s.Data.Devices);
        if (merged.Devices.Count == 0) return stats;

        var energyType = string.IsNullOrWhiteSpace(config.HASS.EnergyDashboard.EnergyMeasurementType) ? "energy" : config.HASS.EnergyDashboard.EnergyMeasurementType;
        var native = FlowExport.NativeEnergyUniqueIds(merged, energyType);
        var graph = FlowGraphBuilder.Build(merged, config.EnergyFlow, FlowGraphBuilder.DefaultMetric, live);
        foreach (var node in graph.Nodes)
        {
            var uid = native.TryGetValue(node.Id, out var nativeUid) ? nativeUid : FlowExport.EnergyUniqueId(node.Id);
            if (entityByUniqueId.TryGetValue(uid, out var e)) stats.Add(e);
        }
        return stats;
    }

    /// <summary>
    /// The Energy-Dashboard <c>energy_sources</c> (grid/solar/battery buckets) the kind-tagged flow nodes map
    /// to — the roll-up on top of the individual-device list. Directions resolve through HA's authoritative
    /// unique_id → entity_id map (Out = the native/energyflow supply sensor; In = the energyflow return
    /// sensor), so a bucket only appears once its stat actually exists in HA.
    /// </summary>
    public List<JsonObject> BuildEnergySources(IReadOnlyDictionary<string, string> entityByUniqueId)
    {
        var merged = new PduData();
        foreach (var s in snapshots.All) merged.Devices.AddRange(s.Data.Devices);
        if (merged.Devices.Count == 0) return new();

        var energyType = string.IsNullOrWhiteSpace(config.HASS.EnergyDashboard.EnergyMeasurementType) ? "energy" : config.HASS.EnergyDashboard.EnergyMeasurementType;
        var native = FlowExport.NativeEnergyUniqueIds(merged, energyType);
        var graph = FlowGraphBuilder.Build(merged, config.EnergyFlow, FlowGraphBuilder.DefaultMetric, live);

        // The three role buckets resolve purely on whether the energy ENTITY exists in HA — no live-value gate.
        // That sensor is published from the node's discovery (off its power reading), so it exists even when the
        // kWh value is momentarily absent; gating on the value here made grid/solar/battery vanish whenever the
        // source ticked slowly. A bucket the user explicitly configured is worth showing when its sensor exists;
        // HA handles availability. (The dozens of individual devices keep their gate — that's where unavailable
        // clutter actually matters.)
        string? Resolve(string uid) => entityByUniqueId.TryGetValue(uid, out var e) ? e : null;
        return EnergyDashboardSync.BuildEnergySources(graph, (id, dir) => dir == Core.Flow.EnergyDirection.Out
            ? Resolve(native.TryGetValue(id, out var nativeUid) ? nativeUid : FlowExport.EnergyUniqueId(id))
            : Resolve(FlowExport.EnergyInUniqueId(id)));
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

        var devices = BuildDevices(entityByUniqueId, config.HASS.EnergyDashboard.ExcludeDeviceKinds);
        var prefs = (await call("energy/get_prefs", null))?["result"]?.AsObject()
            ?? throw new Exception("Could not read HA energy preferences.");

        // "Managed" is every energy entity any flow tier maps to — no kind exclusion AND no energy gate.
        // Dropping all of it before re-adding the kept devices retires a tier we exported before it was
        // excluded (grid/battery/inverter) OR before it lost a live value, instead of orphaning it. The gate
        // must NOT apply here: a grid tier that's momentarily energy-unknown would otherwise fall through the
        // gap — not in `managed` so never removed, not in `devices` so never re-added — and linger forever.
        var managed = ManagedStats(entityByUniqueId);
        var keep = new JsonArray();
        foreach (var existingDevice in prefs["device_consumption"]?.AsArray() ?? new JsonArray())
            if (existingDevice is JsonObject o && !managed.Contains((string?)o["stat_consumption"] ?? ""))
                keep.Add(o.DeepClone());
        foreach (var d in devices)
            keep.Add(JsonSerializer.SerializeToNode(d, Json)!);
        prefs["device_consumption"] = keep;

        // Roll the grid/solar/battery buckets into energy_sources too, preserving any the user set up
        // themselves — an entry is "ours" only when it references a stat we produced (matched by entity_id,
        // not by type), so a hand-added second grid/solar survives.
        var sources = BuildEnergySources(entityByUniqueId);
        var ourStats = sources.SelectMany(EnergyDashboardSync.StatsOf).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var keepSources = new JsonArray();
        foreach (var existing in prefs["energy_sources"]?.AsArray() ?? new JsonArray())
            if (existing is JsonObject o && !EnergyDashboardSync.StatsOf(o).Any(ourStats.Contains))
                keepSources.Add(o.DeepClone());
        foreach (var src in sources)
            keepSources.Add(src.DeepClone());
        prefs["energy_sources"] = keepSources;

        await SavePrefs(call, prefs);
        return devices.Count;
    }

    /// <summary>Remove every device from HA's Energy-Dashboard device list, and the grid/solar/battery sources
    /// we added (but not the user's own). Returns how many devices were cleared.</summary>
    public async Task<int> ClearAsync(string url, string token, CancellationToken ct)
    {
        using var ws = await ConnectAuth(url, token, ct);
        var call = Caller(ws, ct);

        var prefs = (await call("energy/get_prefs", null))?["result"]?.AsObject()
            ?? throw new Exception("Could not read HA energy preferences.");
        var cleared = prefs["device_consumption"]?.AsArray()?.Count ?? 0;
        prefs["device_consumption"] = new JsonArray();

        // Strip only the energy_sources whose stats we produced — a user's hand-configured grid/solar stays.
        var registry = (await call("config/entity_registry/list", null))?["result"]?.AsArray() ?? new JsonArray();
        var entityByUniqueId = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var e in registry)
            if ((string?)e?["unique_id"] is { Length: > 0 } uid && (string?)e?["entity_id"] is { Length: > 0 } eid)
                entityByUniqueId[uid] = eid;

        var ourStats = BuildEnergySources(entityByUniqueId).SelectMany(EnergyDashboardSync.StatsOf).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var keepSources = new JsonArray();
        foreach (var existing in prefs["energy_sources"]?.AsArray() ?? new JsonArray())
            if (existing is JsonObject o && !EnergyDashboardSync.StatsOf(o).Any(ourStats.Contains))
                keepSources.Add(o.DeepClone());
        prefs["energy_sources"] = keepSources;

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
