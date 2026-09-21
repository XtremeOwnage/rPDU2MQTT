namespace rPDU2MQTT.Core.HomeAssistant;

/// <summary>A room as the area plan sees it: its id, name, and the area it was linked to before.</summary>
public sealed record HaRoom(string Id, string Name, string? LinkedArea);

/// <summary>An area in Home Assistant's registry.</summary>
public sealed record HaArea(string AreaId, string Name);

/// <summary>A device in Home Assistant's registry, with its MQTT identifiers.</summary>
public sealed record HaRegistryDevice(string Id, string Name, IReadOnlyList<string> Identifiers, string? AreaId);

/// <summary>What happens to one room's area.</summary>
public sealed record HaRoomAction(string Room, string Name, string Action, string? AreaId, string? AreaName, string Why);

/// <summary>What happens to one of this bridge's devices.</summary>
public sealed record HaDeviceAction(string DeviceId, string DeviceName, string RoomId, string Room, string Action, string? CurrentArea, string Why);

/// <summary>Rooms mapped onto Home Assistant areas, before anything is written (#467).</summary>
public sealed record HaAreaPlan(IReadOnlyList<HaRoomAction> Rooms, IReadOnlyList<HaDeviceAction> Devices, IReadOnlyList<HaArea> LeftAlone)
{
    public const string Create = "create";
    public const string Rename = "rename";
    public const string Link = "link";
    public const string Ok = "ok";
    public const string Set = "set";
    public const string Keep = "keep";

    private static readonly StringComparer Names = StringComparer.OrdinalIgnoreCase;

    /// <param name="deviceRooms">This bridge's device identifiers, and the id of the room each is in.</param>
    public static HaAreaPlan Build(IReadOnlyList<HaRoom> rooms, IReadOnlyList<HaArea> areas, IReadOnlyList<HaRegistryDevice> devices,
        IReadOnlyDictionary<string, string> deviceRooms)
    {
        var roomActions = new List<HaRoomAction>();
        var used = new HashSet<string>(StringComparer.Ordinal);
        foreach (var room in rooms)
        {
            var linked = string.IsNullOrWhiteSpace(room.LinkedArea) ? null : areas.FirstOrDefault(a => a.AreaId == room.LinkedArea);
            if (linked is not null)
            {
                used.Add(linked.AreaId);
                roomActions.Add(Names.Equals(linked.Name, room.Name)
                    ? new(room.Id, room.Name, Ok, linked.AreaId, linked.Name, "Already linked, same name.")
                    : new(room.Id, room.Name, Rename, linked.AreaId, linked.Name, $"Linked area '{linked.Name}' is renamed to '{room.Name}'."));
                continue;
            }
            var byName = areas.FirstOrDefault(a => Names.Equals(a.Name, room.Name) && !used.Contains(a.AreaId));
            if (byName is not null)
            {
                used.Add(byName.AreaId);
                roomActions.Add(new(room.Id, room.Name, Link, byName.AreaId, byName.Name, "An area of the same name exists and is linked to this room."));
                continue;
            }
            roomActions.Add(new(room.Id, room.Name, Create, null, null, room.LinkedArea is { Length: > 0 }
                ? "Its linked area no longer exists in Home Assistant, so a new one is created."
                : "No area of this name exists, so one is created."));
        }

        var areaOf = roomActions.ToDictionary(r => r.Room, r => r, StringComparer.OrdinalIgnoreCase);
        var deviceActions = new List<HaDeviceAction>();
        foreach (var device in devices)
        {
            var roomId = device.Identifiers.Select(i => deviceRooms.GetValueOrDefault(i)).FirstOrDefault(r => r is not null);
            if (roomId is null || !areaOf.TryGetValue(roomId, out var target)) continue;
            var current = device.AreaId is null ? null : areas.FirstOrDefault(a => a.AreaId == device.AreaId)?.Name ?? device.AreaId;
            if (device.AreaId is null)
                deviceActions.Add(new(device.Id, device.Name, target.Room, target.Name, Set, null, $"Put in '{target.Name}'."));
            else if (target.AreaId is not null && device.AreaId == target.AreaId)
                deviceActions.Add(new(device.Id, device.Name, target.Room, target.Name, Ok, current, "Already there."));
            else
                deviceActions.Add(new(device.Id, device.Name, target.Room, target.Name, Keep, current, $"Already in '{current}' in Home Assistant; left there rather than moved."));
        }

        var leftAlone = areas.Where(a => !used.Contains(a.AreaId)).ToList();
        return new HaAreaPlan(roomActions, deviceActions, leftAlone);
    }
}
