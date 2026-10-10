using System.Text.Json.Nodes;
using rPDU2MQTT.Models.PDU;

namespace rPDU2MQTT.Plugin.Locations;

/// <summary>Rooms published to Home Assistant as areas, over one signed-in session (#467).</summary>
internal sealed class HaAreaSync(HomeAssistantSocket session)
{
    /// <summary>This bridge's device identifiers and the room each is in: tiers, places, and native PDUs and outlets.</summary>
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

    private static List<HaRoom> Rooms(LocationIndex index) =>
        [.. index.All.Where(e => e.Kind == LocationKind.Room).Select(e => new HaRoom(e.Id, e.Label, e.Room!.HaArea))];

    private async Task<(IReadOnlyList<HaArea> Areas, IReadOnlyList<HaRegistryDevice> Devices)> ReadRegistry()
    {
        var areas = new List<HaArea>();
        foreach (var a in (await session.CallAsync("config/area_registry/list"))?["result"]?.AsArray() ?? new JsonArray())
            if ((string?)a?["area_id"] is { Length: > 0 } id) areas.Add(new(id, (string?)a?["name"] ?? id));

        var devices = new List<HaRegistryDevice>();
        foreach (var d in (await session.CallAsync("config/device_registry/list"))?["result"]?.AsArray() ?? new JsonArray())
        {
            if ((string?)d?["id"] is not { Length: > 0 } id) continue;
            var idents = new List<string>();
            foreach (var pair in d?["identifiers"]?.AsArray() ?? new JsonArray())
                if (pair is JsonArray a && a.Count > 1 && (string?)a[1] is { } value) idents.Add(value);
            devices.Add(new(id, (string?)d?["name_by_user"] ?? (string?)d?["name"] ?? id, idents, (string?)d?["area_id"]));
        }
        return (areas, devices);
    }

    /// <summary>What publishing rooms as areas would do, read from Home Assistant but writing nothing.</summary>
    public async Task<HaAreaPlan> PlanAsync(LocationIndex index, IReadOnlyDictionary<string, string> deviceRooms)
    {
        var (areas, devices) = await ReadRegistry();
        return HaAreaPlan.Build(Rooms(index), areas, devices, deviceRooms);
    }

    /// <summary>Create, rename and link the areas, and put unplaced devices in them. Returns each room's area id.</summary>
    public async Task<(HaAreaPlan Plan, Dictionary<string, string> Linked, List<string> Failed)> ApplyAsync(
        LocationIndex index, IReadOnlyDictionary<string, string> deviceRooms)
    {
        var plan = await PlanAsync(index, deviceRooms);
        var linked = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var failed = new List<string>();
        foreach (var r in plan.Rooms)
        {
            JsonNode? reply = r.Action switch
            {
                HaAreaPlan.Create => await session.CallAsync("config/area_registry/create", new JsonObject { ["name"] = r.Name }),
                HaAreaPlan.Rename => await session.CallAsync("config/area_registry/update", new JsonObject { ["area_id"] = r.AreaId, ["name"] = r.Name }),
                _ => null,
            };
            if (reply is not null && (bool?)reply["success"] != true) { failed.Add($"{r.Name}: {reply["error"]?["message"]}"); continue; }
            var areaId = r.Action == HaAreaPlan.Create ? (string?)reply?["result"]?["area_id"] : r.AreaId;
            if (!string.IsNullOrEmpty(areaId)) linked[r.Room] = areaId;
        }

        foreach (var d in plan.Devices.Where(d => d.Action == HaAreaPlan.Set))
        {
            if (!linked.TryGetValue(d.RoomId, out var areaId)) continue;
            var reply = await session.CallAsync("config/device_registry/update", new JsonObject { ["device_id"] = d.DeviceId, ["area_id"] = areaId });
            if ((bool?)reply?["success"] != true) failed.Add($"{d.DeviceName}: {reply?["error"]?["message"]}");
        }
        return (plan, linked, failed);
    }
}
