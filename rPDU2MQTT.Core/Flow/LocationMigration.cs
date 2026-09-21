using System.Text.RegularExpressions;
using rPDU2MQTT.Models.Config;

namespace rPDU2MQTT.Core.Flow;

/// <summary>What one tag should become: a room or area on a floor, an existing place, or nothing.</summary>
public sealed class TagMapping
{
    public string Tag { get; set; } = "";
    /// <summary>"room", "area", "existing" or "skip".</summary>
    public string As { get; set; } = "skip";
    /// <summary>The floor a new room or area goes on.</summary>
    public string Floor { get; set; } = "";
    /// <summary>The existing place, when <see cref="As"/> is "existing".</summary>
    public string Location { get; set; } = "";
    public string Name { get; set; } = "";
    /// <summary>Take the tag off what carried it once it is a location.</summary>
    public bool RemoveTag { get; set; }
}

/// <summary>A place the migration would create.</summary>
public sealed record MigrationCreate(string Id, string Name, string Kind, string Floor, string Tag);

/// <summary>A node the migration would place, and why.</summary>
public sealed record MigrationNode(string Node, string Location, IReadOnlyList<string> Tags, string? Note);

/// <summary>A rule for derived nodes the migration would add.</summary>
public sealed record MigrationRule(string Match, string Location, string Tag);

/// <summary>Something the migration leaves alone, and why.</summary>
public sealed record MigrationSkip(string What, string Why);

/// <summary>Everything a migration would write, before any of it is (#461).</summary>
public sealed record MigrationPlan(
    IReadOnlyList<MigrationCreate> Creates,
    IReadOnlyList<MigrationNode> Nodes,
    IReadOnlyList<MigrationRule> Rules,
    IReadOnlyList<string> RemoveTags,
    IReadOnlyList<MigrationSkip> Skipped);

/// <summary>Room and area tags from Version 2.0, turned into locations (#461). Plans only: the page applies what it is shown.</summary>
public static partial class LocationMigration
{
    private static readonly StringComparer Ids = StringComparer.OrdinalIgnoreCase;

    private static readonly string[] RoomWords =
    [
        "kitchen", "garage", "bedroom", "bathroom", "bath", "office", "living", "lounge", "dining", "laundry", "utility",
        "basement", "attic", "hall", "hallway", "den", "closet", "pantry", "porch", "patio", "shed", "workshop", "nursery",
        "study", "loft", "mudroom", "foyer", "entry", "family", "playroom", "gym", "cellar", "server", "theater", "theatre",
    ];

    private static readonly string[] AreaWords = ["upstairs", "downstairs", "outside", "outdoor", "exterior", "yard", "corner", "wing", "zone"];

    [GeneratedRegex("[^a-z0-9]+")]
    private static partial Regex NonId();

    /// <summary>An id from a tag: lower case, words joined by underscores.</summary>
    public static string IdFor(string tag) => NonId().Replace(tag.Trim().ToLowerInvariant(), "_").Trim('_');

    /// <summary>A name from a tag: "master_bedroom" reads "Master Bedroom".</summary>
    public static string NameFor(string tag) =>
        string.Join(' ', IdFor(tag).Split('_', StringSplitOptions.RemoveEmptyEntries).Select(w => char.ToUpperInvariant(w[0]) + w[1..]));

    /// <summary>What a tag looks like it is: "room", "area", or "skip" when it reads like anything else.</summary>
    public static string Suggest(string tag)
    {
        var words = IdFor(tag).Split('_', StringSplitOptions.RemoveEmptyEntries);
        if (words.Any(w => AreaWords.Contains(w))) return LocationKind.Area;
        if (words.Any(w => RoomWords.Contains(w) || RoomWords.Contains(w.TrimEnd('s')))) return LocationKind.Room;
        return "skip";
    }

    /// <summary>Every tag in use, on nodes and on rules, with how many carry it.</summary>
    public static IReadOnlyList<(string Tag, int Count)> TagsInUse(EnergyFlowConfig flow) =>
        flow.Nodes.SelectMany(n => n.Tags ?? []).Concat((flow.AutoTags ?? []).SelectMany(r => r.Tags ?? []))
            .Concat((flow.Tags ?? []).Select(t => t.Name))
            .Where(t => !string.IsNullOrWhiteSpace(t))
            .GroupBy(t => t.Trim(), Ids)
            .Select(g => (g.Key, flow.Nodes.Count(n => (n.Tags ?? []).Contains(g.Key, Ids)) + (flow.AutoTags ?? []).Count(r => (r.Tags ?? []).Contains(g.Key, Ids))))
            .OrderBy(x => x.Key, Ids)
            .ToList();

    public static MigrationPlan Plan(EnergyFlowConfig flow, IEnumerable<TagMapping> mappings)
    {
        var index = LocationIndex.For(flow);
        var creates = new List<MigrationCreate>();
        var skipped = new List<MigrationSkip>();
        var target = new Dictionary<string, string>(Ids);     // tag -> location id

        foreach (var m in mappings.Where(m => !string.IsNullOrWhiteSpace(m.Tag) && m.As != "skip"))
        {
            if (m.As == "existing")
            {
                if (index.Contains(m.Location)) target[m.Tag] = index[m.Location]!.Id;
                else skipped.Add(new($"tag '{m.Tag}'", $"'{m.Location}' is not a room, area, floor or site."));
                continue;
            }
            if (m.As is not (LocationKind.Room or LocationKind.Area)) continue;
            var floor = index[m.Floor];
            if (floor is null || floor.Kind != LocationKind.Floor) { skipped.Add(new($"tag '{m.Tag}'", "No floor was chosen for it.")); continue; }

            var id = IdFor(m.Tag);
            if (id.Length == 0) { skipped.Add(new($"tag '{m.Tag}'", "It has no letters or digits to make an id from.")); continue; }
            if (index[id] is { } existing)
            {
                target[m.Tag] = existing.Id;
                skipped.Add(new($"{m.As} '{id}'", $"Already exists as a {existing.Kind}; the tag is mapped to it rather than making a second."));
                continue;
            }
            if (creates.Any(c => Ids.Equals(c.Id, id))) { target[m.Tag] = id; continue; }
            creates.Add(new(id, string.IsNullOrWhiteSpace(m.Name) ? NameFor(m.Tag) : m.Name.Trim(), m.As, floor.Id, m.Tag));
            target[m.Tag] = id;
        }

        // Where two mapped tags meet on one node it goes to the smallest place holding both; new places are judged by their floor.
        string? Where(IReadOnlyList<string> tags)
        {
            var places = tags.Select(t => target[t]).Distinct(Ids).ToList();
            if (places.Count == 1) return places[0];
            var anchors = places.Select(p => index.Contains(p) ? p : creates.First(c => Ids.Equals(c.Id, p)).Floor).ToList();
            return index.Common(anchors);
        }

        var nodes = new List<MigrationNode>();
        foreach (var n in flow.Nodes.Where(n => !string.IsNullOrWhiteSpace(n.Id)))
        {
            var tags = (n.Tags ?? []).Where(t => target.ContainsKey(t)).ToList();
            if (tags.Count == 0) continue;
            if (!string.IsNullOrWhiteSpace(n.Location))
            {
                skipped.Add(new($"node '{n.Id}'", $"Already in '{n.Location}'; left there."));
                continue;
            }
            var where = Where(tags);
            if (where is null) { skipped.Add(new($"node '{n.Id}'", $"Its tags {string.Join(", ", tags)} share no site.")); continue; }
            nodes.Add(new(n.Id, where, tags, tags.Count > 1 ? $"Tagged {string.Join(" and ", tags)}, so placed in the place holding both." : null));
        }

        var rules = new List<MigrationRule>();
        foreach (var r in flow.AutoTags ?? [])
        {
            var tags = (r.Tags ?? []).Where(t => target.ContainsKey(t)).ToList();
            if (tags.Count == 0 || string.IsNullOrWhiteSpace(r.Match)) continue;
            if ((flow.AutoLocations ?? []).Any(a => Ids.Equals(a.Match, r.Match)))
            {
                skipped.Add(new($"rule '{r.Match}'", "Already has a location rule; left as it is."));
                continue;
            }
            if (Where(tags) is { } where) rules.Add(new(r.Match, where, string.Join(", ", tags)));
        }

        var remove = mappings.Where(m => m.RemoveTag && target.ContainsKey(m.Tag)).Select(m => m.Tag).Distinct(Ids).ToList();
        return new MigrationPlan(creates, nodes, rules, remove, skipped);
    }
}
