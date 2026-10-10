using System.Text.Json.Nodes;
using rPDU2MQTT.Models.PDU;

namespace rPDU2MQTT.Plugin.Locations;

/// <summary>Rooms as Home Assistant areas (#467).</summary>
internal sealed class HaAreaSync(HomeAssistantSocket session)
{
    /// <summary>Device identifier → room id.</summary>
    public static IReadOnlyDictionary<string, string> DeviceRooms(LocationIndex index, PduData merged, EnergyFlowConfig flow)
    {
        var placed = LocationRollup.Placed(index, FlowTopology.For(merged, flow))
            .Where(kv => index[kv.Value] is { Kind: LocationKind.Room })
            .ToDictionary(kv => kv.Key, kv => index[kv.Value]!.Id, StringComparer.OrdinalIgnoreCase);

        var rooms = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var (node, room) in placed) rooms[FlowExport.DeviceId(node)] = room;
        foreach (var d in merged.Devices)
        {
            if (placed.TryGetValue(FlowNodeId.ForPdu(d.Entity_Name), out var pr) && !string.IsNullOrEmpty(d.Entity_Identifier)) rooms[d.Entity_Identifier] = pr;
            foreach (var o in d.Outlets)
                if (placed.TryGetValue(FlowNodeId.ForOutlet(d.Entity_Name, o.Key), out var or) && !string.IsNullOrEmpty(o.Entity_Identifier)) rooms[o.Entity_Identifier] = or;
        }
        foreach (var room in index.All.Where(e => e.Kind == LocationKind.Room))
            rooms[FlowExport.DeviceId(LocationExport.NodeId(room.Id))] = room.Id;
        return rooms;
    }

    private static List<HaRoom> Rooms(LocationIndex index, IReadOnlyDictionary<string, string> entities)
    {
        string? Entity(LocationEntry e, string key) =>
            entities.GetValueOrDefault($"{FlowExport.DeviceId(LocationExport.NodeId(e.Id))}_{key}");
        return [.. index.All.Where(e => e.Kind == LocationKind.Room).Select(e => new HaRoom(e.Id, e.Label, e.Room!.HaArea, e.Floor?.Id,
            LocationClimate.SensorIds(index, e, c => c.Temperature).Count > 0 ? Entity(e, "temperature") : null,
            LocationClimate.SensorIds(index, e, c => c.Humidity).Count > 0 ? Entity(e, "humidity") : null))];
    }

    private static List<HaFloorIn> Floors(LocationIndex index) =>
        [.. index.All.Where(e => e.Kind == LocationKind.Floor).Select(e => new HaFloorIn(e.Id, e.Label, e.Floor!.Level, e.Floor.HaFloor))];

    private static JsonArray List(JsonNode? reply) => reply?["result"]?.AsArray() ?? new JsonArray();

    private async Task<(List<HaArea> Areas, List<HaRegistryDevice> Devices, List<HaFloor> Floors, Dictionary<string, string> Entities)> ReadRegistry(HaSyncConfig modes)
    {
        var areas = new List<HaArea>();
        foreach (var a in List(await session.CallAsync("config/area_registry/list")))
            if ((string?)a?["area_id"] is { Length: > 0 } id)
                areas.Add(new(id, (string?)a?["name"] ?? id, (string?)a?["floor_id"], (string?)a?["temperature_entity_id"], (string?)a?["humidity_entity_id"]));

        var devices = new List<HaRegistryDevice>();
        if (modes.DeviceAreas != HaSyncMode.Off)
            foreach (var d in List(await session.CallAsync("config/device_registry/list")))
            {
                if ((string?)d?["id"] is not { Length: > 0 } id) continue;
                var idents = new List<string>();
                foreach (var pair in d?["identifiers"]?.AsArray() ?? new JsonArray())
                    if (pair is JsonArray a && a.Count > 1 && (string?)a[1] is { } value) idents.Add(value);
                devices.Add(new(id, (string?)d?["name_by_user"] ?? (string?)d?["name"] ?? id, idents, (string?)d?["area_id"]));
            }

        var floors = new List<HaFloor>();
        if (modes.Floors != HaSyncMode.Off)
            foreach (var f in List(await session.CallAsync("config/floor_registry/list")))
                if ((string?)f?["floor_id"] is { Length: > 0 } id) floors.Add(new(id, (string?)f?["name"] ?? id, (int?)f?["level"]));

        var entities = new Dictionary<string, string>(StringComparer.Ordinal);
        if (modes.AreaSensors != HaSyncMode.Off)
            foreach (var e in List(await session.CallAsync("config/entity_registry/list")))
                if ((string?)e?["platform"] == "mqtt" && (string?)e?["unique_id"] is { } uid && (string?)e?["entity_id"] is { } eid) entities[uid] = eid;
        return (areas, devices, floors, entities);
    }

    /// <summary>Read-only preview.</summary>
    public async Task<HaAreaPlan> PlanAsync(LocationIndex index, IReadOnlyDictionary<string, string> deviceRooms, HaSyncConfig modes)
    {
        var (areas, devices, floors, entities) = await ReadRegistry(modes);
        return HaAreaPlan.Build(Rooms(index, entities), areas, devices, deviceRooms, modes, Floors(index), floors);
    }

    private static string? Failed(JsonNode? reply, string what) =>
        reply is not null && (bool?)reply["success"] != true ? $"{what}: {reply["error"]?["message"]}" : null;

    /// <summary>Applies the plan; returns room id → area id and floor id → HA floor id.</summary>
    public async Task<(HaAreaPlan Plan, Dictionary<string, string> Linked, Dictionary<string, string> LinkedFloors, List<string> Failed)> ApplyAsync(
        LocationIndex index, IReadOnlyDictionary<string, string> deviceRooms, HaSyncConfig modes)
    {
        var plan = await PlanAsync(index, deviceRooms, modes);
        var failed = new List<string>();

        var floors = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var f in plan.Floors.Where(f => f.Action != HaAreaPlan.Skip))
        {
            JsonNode? reply = f.Action switch
            {
                HaAreaPlan.Create => await session.CallAsync("config/floor_registry/create", new JsonObject { ["name"] = f.Name, ["level"] = f.Level }),
                HaAreaPlan.Rename => await session.CallAsync("config/floor_registry/update", new JsonObject { ["floor_id"] = f.FloorId, ["name"] = f.Name, ["level"] = f.Level }),
                _ => null,
            };
            if (Failed(reply, f.Name) is { } why) { failed.Add(why); continue; }
            var id = f.Action == HaAreaPlan.Create ? (string?)reply?["result"]?["floor_id"] : f.FloorId;
            if (!string.IsNullOrEmpty(id)) floors[f.Floor] = id;
        }

        var linked = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var r in plan.Rooms.Where(r => r.Action != HaAreaPlan.Skip))
        {
            JsonNode? reply = r.Action switch
            {
                HaAreaPlan.Create => await session.CallAsync("config/area_registry/create", new JsonObject { ["name"] = r.Name }),
                HaAreaPlan.Rename => await session.CallAsync("config/area_registry/update", new JsonObject { ["area_id"] = r.AreaId, ["name"] = r.Name }),
                _ => null,
            };
            if (Failed(reply, r.Name) is { } why) { failed.Add(why); continue; }
            var areaId = r.Action == HaAreaPlan.Create ? (string?)reply?["result"]?["area_id"] : r.AreaId;
            if (!string.IsNullOrEmpty(areaId)) linked[r.Room] = areaId;
        }

        var floorOfRoom = index.All.Where(e => e.Kind == LocationKind.Room).ToDictionary(e => e.Id, e => e.Floor?.Id, StringComparer.OrdinalIgnoreCase);
        foreach (var group in plan.Fields.Where(x => x.Action == HaAreaPlan.Set).GroupBy(x => x.Room))
        {
            if (!linked.TryGetValue(group.Key, out var areaId)) continue;
            var update = new JsonObject { ["area_id"] = areaId };
            foreach (var x in group)
            {
                if (x.Field == "floor")
                {
                    if (floorOfRoom.GetValueOrDefault(group.Key) is { } ours && floors.TryGetValue(ours, out var fid)) update["floor_id"] = fid;
                }
                else update[$"{x.Field}_entity_id"] = x.Value;
            }
            if (update.Count == 1) continue;
            if (Failed(await session.CallAsync("config/area_registry/update", update), group.First().Name) is { } why) failed.Add(why);
        }

        foreach (var d in plan.Devices.Where(d => d.Action == HaAreaPlan.Set))
        {
            if (!linked.TryGetValue(d.RoomId, out var areaId)) continue;
            var reply = await session.CallAsync("config/device_registry/update", new JsonObject { ["device_id"] = d.DeviceId, ["area_id"] = areaId });
            if ((bool?)reply?["success"] != true) failed.Add($"{d.DeviceName}: {reply?["error"]?["message"]}");
        }
        return (plan, linked, floors, failed);
    }
}
