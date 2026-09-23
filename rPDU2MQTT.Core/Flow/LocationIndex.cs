using rPDU2MQTT.Models.Config;

namespace rPDU2MQTT.Core.Flow;

/// <summary>One place in the location tree: a site, floor, room or area (#461).</summary>
public sealed record LocationEntry(string Id, string Name, string Kind, SiteConfig Site, FloorConfig? Floor = null,
    RoomConfig? Room = null, AreaConfig? Area = null)
{
    /// <summary>The name to show: the configured name, or the id when there is none.</summary>
    public string Label => string.IsNullOrWhiteSpace(Name) ? Id : Name;
}

/// <summary>
/// The location tree resolved (#461): every site, floor, room and area by id, which places each one counts
/// toward, and where a node is.
/// </summary>
public sealed class LocationIndex
{
    private static readonly StringComparer Ids = StringComparer.OrdinalIgnoreCase;
    private readonly Dictionary<string, LocationEntry> byId = new(Ids);
    private readonly List<LocationEntry> all = new();
    private readonly Dictionary<string, HashSet<string>> containers = new(Ids);
    private readonly List<string> problems = new();
    private readonly EnergyFlowConfig flow;
    private readonly Dictionary<string, string> circuitLocation = new(Ids);

    private LocationIndex(EnergyFlowConfig flow) => this.flow = flow;

    public static LocationIndex For(EnergyFlowConfig? flow)
    {
        var index = new LocationIndex(flow ?? new EnergyFlowConfig());
        index.Build();
        return index;
    }

    /// <summary>Every place, sites first, then each site's floors by level with their rooms and areas.</summary>
    public IReadOnlyList<LocationEntry> All => all;

    /// <summary>What is wrong with the tree as written: duplicate or blank ids, areas naming rooms that are not on their floor.</summary>
    public IReadOnlyList<string> Problems => problems;

    public LocationEntry? this[string? id] => !string.IsNullOrWhiteSpace(id) && byId.TryGetValue(id.Trim(), out var e) ? e : null;

    public bool Contains(string? id) => this[id] is not null;

    /// <summary>The places <paramref name="id"/> counts toward, itself included: a room counts toward its areas, floor and site.</summary>
    public IReadOnlySet<string> Containers(string? id) =>
        !string.IsNullOrWhiteSpace(id) && containers.TryGetValue(id.Trim(), out var set) ? set : new HashSet<string>(Ids);

    /// <summary>Does something in <paramref name="id"/> count toward <paramref name="container"/>?</summary>
    public bool Within(string? id, string container) => Containers(id).Contains(container);

    /// <summary>
    /// The smallest single place holding every one of <paramref name="ids"/>: the place itself when there is one,
    /// the smallest area taking them all in, else their floor, else their site. Null when they share no site.
    /// </summary>
    public string? Common(IEnumerable<string?> ids)
    {
        var known = ids.Select(i => this[i]).Where(e => e is not null).Select(e => e!).DistinctBy(e => e.Id, Ids).ToList();
        if (known.Count == 0) return null;
        if (known.Count == 1) return known[0].Id;

        var shared = new HashSet<string>(Containers(known[0].Id), Ids);
        foreach (var e in known.Skip(1)) shared.IntersectWith(Containers(e.Id));
        if (shared.Count == 0) return null;

        // Smallest first: a room, then the area with the fewest rooms, then the floor, then the site.
        return shared.Select(id => byId[id])
            .OrderBy(e => e.Kind switch { LocationKind.Room => 0, LocationKind.Area => 1, LocationKind.Floor => 2, _ => 3 })
            .ThenBy(e => e.Area?.Rooms.Count ?? 0)
            .First().Id;
    }

    /// <summary>The rooms an area or floor takes in, or the room itself.</summary>
    public IEnumerable<LocationEntry> RoomsIn(string id) =>
        all.Where(e => e.Kind == LocationKind.Room && Within(e.Id, id));

    /// <summary>
    /// Where a node is: its own Location, then an exact-id rule, then a placement metering it, then a pattern
    /// rule, then the rooms its circuit serves. Null when nothing places it, or it names a place that does not exist.
    /// </summary>
    public string? LocationOf(string nodeId)
    {
        if (string.IsNullOrWhiteSpace(nodeId)) return null;

        var node = flow.Nodes.FirstOrDefault(n => Ids.Equals(n.Id, nodeId));
        if (Contains(node?.Location)) return this[node!.Location]!.Id;

        var rules = flow.AutoLocations ?? new();
        var exact = rules.FirstOrDefault(r => !r.Match.Contains('*') && Ids.Equals(r.Match.Trim(), nodeId) && Contains(r.Location));
        if (exact is not null) return this[exact.Location]!.Id;

        // An item outside every room is on its floor: outdoors, or anywhere not drawn as a room.
        var placed = (flow.Placements ?? new()).FirstOrDefault(p => Ids.Equals(p.Node, nodeId) && (Contains(p.Room) || Contains(p.Floor)));
        if (placed is not null) return this[Contains(placed.Room) ? placed.Room : placed.Floor]!.Id;

        var pattern = rules.FirstOrDefault(r => r.Match.Contains('*') && AutoTags.Matches(r.Match.Trim(), nodeId) && Contains(r.Location));
        if (pattern is not null) return this[pattern.Location]!.Id;

        return circuitLocation.TryGetValue(nodeId, out var served) ? served : null;
    }

    private void Build()
    {
        void Add(LocationEntry e, IEnumerable<string> countsToward)
        {
            if (string.IsNullOrWhiteSpace(e.Id)) { problems.Add($"A {e.Kind} named '{e.Label}' has no id, so nothing can refer to it."); return; }
            if (byId.ContainsKey(e.Id)) { problems.Add($"The id '{e.Id}' is used twice. Every site, floor, room and area needs its own."); return; }
            byId[e.Id] = e;
            all.Add(e);
            containers[e.Id] = new HashSet<string>(countsToward.Prepend(e.Id), Ids);
        }

        foreach (var site in flow.Sites ?? new())
        {
            var siteId = site.Id?.Trim() ?? "";
            Add(new LocationEntry(siteId, site.Name, LocationKind.Site, site), []);
            foreach (var floor in (site.Floors ?? new()).OrderBy(f => f.Level))
            {
                var floorId = floor.Id?.Trim() ?? "";
                Add(new LocationEntry(floorId, floor.Name, LocationKind.Floor, site, floor), [siteId]);
                foreach (var room in floor.Rooms ?? new())
                    Add(new LocationEntry(room.Id?.Trim() ?? "", room.Name, LocationKind.Room, site, floor, Room: room), [floorId, siteId]);
                foreach (var area in floor.Areas ?? new())
                    Add(new LocationEntry(area.Id?.Trim() ?? "", area.Name, LocationKind.Area, site, floor, Area: area), [floorId, siteId]);
            }
        }

        // A room counts toward every area taking it in; an area only takes in rooms on its own floor.
        foreach (var area in all.Where(e => e.Kind == LocationKind.Area).ToList())
            foreach (var roomId in area.Area!.Rooms ?? new())
            {
                var room = this[roomId];
                if (room is null || room.Kind != LocationKind.Room)
                    problems.Add($"Area '{area.Label}' takes in '{roomId}', which is not a room.");
                else if (!ReferenceEquals(room.Floor, area.Floor))
                    problems.Add($"Area '{area.Label}' takes in '{room.Label}', which is on another floor.");
                else
                    containers[room.Id].Add(area.Id);
            }

        // A circuit's node is where the rooms it serves are.
        var map = PanelMap.For(flow);
        var known = PanelNodes.NodeIds(flow);
        foreach (var chain in map.Chains)
        {
            var node = Circuits.NodeOf(chain, known);
            if (node is null) continue;
            var served = Common(chain.Breaker.Rooms ?? new());
            if (served is not null && !circuitLocation.ContainsKey(node)) circuitLocation[node] = served;
        }
    }
}
