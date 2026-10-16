namespace rPDU2MQTT.Plugin.Locations;

/// <summary>A room as the area plan sees it.</summary>
/// <param name="Floor">Our floor id.</param>
/// <param name="Temperature">Its temperature entity, when it has climate.</param>
public sealed record HaRoom(string Id, string Name, string? LinkedArea, string? Floor = null, string? Temperature = null, string? Humidity = null);

/// <summary>A floor as the plan sees it.</summary>
public sealed record HaFloorIn(string Id, string Name, int Level, string? LinkedFloor);

/// <summary>An area in Home Assistant's registry.</summary>
public sealed record HaArea(string AreaId, string Name, string? FloorId = null, string? Temperature = null, string? Humidity = null);

/// <summary>A floor in Home Assistant's registry.</summary>
public sealed record HaFloor(string FloorId, string Name, int? Level);

/// <summary>A device in Home Assistant's registry, with its MQTT identifiers.</summary>
public sealed record HaRegistryDevice(string Id, string Name, IReadOnlyList<string> Identifiers, string? AreaId);

public sealed record HaRoomAction(string Room, string Name, string Action, string? AreaId, string? AreaName, string Why);

public sealed record HaFloorAction(string Floor, string Name, int Level, string Action, string? FloorId, string? FloorName, string Why);

/// <summary>An area field to set: floor, temperature or humidity.</summary>
public sealed record HaAreaFieldAction(string Room, string Name, string Field, string? Value, string? Current, string Action, string Why);

public sealed record HaDeviceAction(string DeviceId, string DeviceName, string RoomId, string Room, string Action, string? CurrentArea, string Why);

public sealed record HaAreaPlan(IReadOnlyList<HaRoomAction> Rooms, IReadOnlyList<HaDeviceAction> Devices, IReadOnlyList<HaArea> LeftAlone)
{
    public const string Create = "create";
    public const string Rename = "rename";
    public const string Link = "link";
    public const string Ok = "ok";
    public const string Set = "set";
    public const string Keep = "keep";
    public const string Skip = "skip";

    public IReadOnlyList<HaFloorAction> Floors { get; init; } = [];
    public IReadOnlyList<HaAreaFieldAction> Fields { get; init; } = [];

    private static readonly StringComparer Names = StringComparer.OrdinalIgnoreCase;

    /// <param name="deviceRooms">This bridge's device identifiers, and the id of the room each is in.</param>
    public static HaAreaPlan Build(IReadOnlyList<HaRoom> rooms, IReadOnlyList<HaArea> areas, IReadOnlyList<HaRegistryDevice> devices,
        IReadOnlyDictionary<string, string> deviceRooms, HaSyncConfig? modes = null,
        IReadOnlyList<HaFloorIn>? floors = null, IReadOnlyList<HaFloor>? haFloors = null)
    {
        modes ??= HaSyncConfig.Today;
        var floorActions = PlanFloors(floors ?? [], haFloors ?? [], modes.Floors);

        var roomActions = new List<HaRoomAction>();
        var used = new HashSet<string>(StringComparer.Ordinal);
        foreach (var room in rooms)
        {
            var linked = string.IsNullOrWhiteSpace(room.LinkedArea) ? null : areas.FirstOrDefault(a => a.AreaId == room.LinkedArea);
            if (linked is not null)
            {
                used.Add(linked.AreaId);
                roomActions.Add(Names.Equals(linked.Name, room.Name) || modes.Areas == HaSyncMode.Off
                    ? new(room.Id, room.Name, Ok, linked.AreaId, linked.Name, "Linked.")
                    : new(room.Id, room.Name, Rename, linked.AreaId, linked.Name, $"Rename '{linked.Name}' to '{room.Name}'."));
                continue;
            }
            var byName = areas.FirstOrDefault(a => Names.Equals(a.Name, room.Name) && !used.Contains(a.AreaId));
            if (byName is not null)
            {
                used.Add(byName.AreaId);
                roomActions.Add(new(room.Id, room.Name, Link, byName.AreaId, byName.Name, "Same name."));
                continue;
            }
            roomActions.Add(modes.Areas == HaSyncMode.Create
                ? new(room.Id, room.Name, Create, null, null, room.LinkedArea is { Length: > 0 } ? "Linked area no longer exists." : "No area of this name.")
                : new(room.Id, room.Name, Skip, null, null, $"No area; Areas is {modes.Areas}."));
        }

        var areaOf = roomActions.ToDictionary(r => r.Room, r => r, StringComparer.OrdinalIgnoreCase);
        var deviceActions = new List<HaDeviceAction>();
        if (modes.DeviceAreas != HaSyncMode.Off)
            foreach (var device in devices)
            {
                var roomId = device.Identifiers.Select(i => deviceRooms.GetValueOrDefault(i)).FirstOrDefault(r => r is not null);
                if (roomId is null || !areaOf.TryGetValue(roomId, out var target) || target.Action == Skip) continue;
                var current = device.AreaId is null ? null : areas.FirstOrDefault(a => a.AreaId == device.AreaId)?.Name ?? device.AreaId;
                if (device.AreaId is null)
                    deviceActions.Add(new(device.Id, device.Name, target.Room, target.Name, Set, null, $"Put in '{target.Name}'."));
                else if (target.AreaId is not null && device.AreaId == target.AreaId)
                    deviceActions.Add(new(device.Id, device.Name, target.Room, target.Name, Ok, current, "Already there."));
                else
                    deviceActions.Add(new(device.Id, device.Name, target.Room, target.Name, Keep, current, $"In '{current}'; left there."));
            }

        var fields = new List<HaAreaFieldAction>();
        var floorOf = floorActions.ToDictionary(f => f.Floor, f => f, StringComparer.OrdinalIgnoreCase);
        foreach (var room in rooms)
        {
            var target = areaOf[room.Id];
            if (target.Action == Skip) continue;
            var area = target.AreaId is null ? null : areas.FirstOrDefault(a => a.AreaId == target.AreaId);
            if (modes.Floors != HaSyncMode.Off && room.Floor is not null && floorOf.TryGetValue(room.Floor, out var fl) && fl.Action != Skip)
                fields.Add(Field(room, "floor", fl.FloorId, area?.FloorId, always: true, fl.Name));
            if (modes.AreaSensors != HaSyncMode.Off)
            {
                if (room.Temperature is not null) fields.Add(Field(room, "temperature", room.Temperature, area?.Temperature, modes.AreaSensors == HaSyncMode.Always, room.Temperature));
                if (room.Humidity is not null) fields.Add(Field(room, "humidity", room.Humidity, area?.Humidity, modes.AreaSensors == HaSyncMode.Always, room.Humidity));
            }
        }

        var leftAlone = areas.Where(a => !used.Contains(a.AreaId)).ToList();
        return new HaAreaPlan(roomActions, deviceActions, leftAlone) { Floors = floorActions, Fields = fields };
    }

    /// <param name="value">Null when the floor is yet to be created.</param>
    private static HaAreaFieldAction Field(HaRoom room, string field, string? value, string? current, bool always, string show)
    {
        if (value is not null && current == value) return new(room.Id, room.Name, field, value, current, Ok, "Already set.");
        if (current is not null && !always) return new(room.Id, room.Name, field, value, current, Keep, $"Already {current}; left.");
        return new(room.Id, room.Name, field, value, current, Set, $"Set to {show}.");
    }

    private static List<HaFloorAction> PlanFloors(IReadOnlyList<HaFloorIn> floors, IReadOnlyList<HaFloor> haFloors, string mode)
    {
        var actions = new List<HaFloorAction>();
        if (mode == HaSyncMode.Off) return actions;
        var used = new HashSet<string>(StringComparer.Ordinal);
        foreach (var f in floors)
        {
            var linked = string.IsNullOrWhiteSpace(f.LinkedFloor) ? null : haFloors.FirstOrDefault(h => h.FloorId == f.LinkedFloor);
            if (linked is not null)
            {
                used.Add(linked.FloorId);
                actions.Add(Names.Equals(linked.Name, f.Name) && linked.Level == f.Level
                    ? new(f.Id, f.Name, f.Level, Ok, linked.FloorId, linked.Name, "Linked.")
                    : new(f.Id, f.Name, f.Level, Rename, linked.FloorId, linked.Name, $"Update '{linked.Name}' to '{f.Name}', level {f.Level}."));
                continue;
            }
            var byName = haFloors.FirstOrDefault(h => Names.Equals(h.Name, f.Name) && !used.Contains(h.FloorId));
            if (byName is not null)
            {
                used.Add(byName.FloorId);
                actions.Add(new(f.Id, f.Name, f.Level, Link, byName.FloorId, byName.Name, "Same name."));
                continue;
            }
            actions.Add(mode == HaSyncMode.Create
                ? new(f.Id, f.Name, f.Level, Create, null, null, "No floor of this name.")
                : new(f.Id, f.Name, f.Level, Skip, null, null, $"No floor; Floors is {mode}."));
        }
        return actions;
    }
}
