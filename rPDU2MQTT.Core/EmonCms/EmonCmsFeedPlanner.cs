using rPDU2MQTT.Classes;
using rPDU2MQTT.Helpers;
using rPDU2MQTT.Models.PDU;

namespace rPDU2MQTT.Core.EmonCms;

/// <summary>An EmonCMS input as returned by <c>input/get_inputs</c>: its id, key and processlist.</summary>
public sealed record EmonInput(int Id, string Name, string ProcessList);

/// <summary>An EmonCMS feed as returned by <c>feed/list</c>.</summary>
public sealed record EmonFeed(int Id, string Name, string? Tag);

/// <summary>Create a new feed for <paramref name="InputName"/> and log that input into it.</summary>
public sealed record CreateFeed(int InputId, string InputName, string FeedName, string Tag, int Engine, int IntervalSeconds);

/// <summary>Log an input into a feed that already exists under the wanted name.</summary>
public sealed record LinkFeed(int InputId, int FeedId, string InputName, string FeedName);

/// <summary>Rename a feed whose source's display name changed (keeps the feed in sync — #163).</summary>
public sealed record RenameFeed(int FeedId, string FromName, string ToName);

/// <summary>The reconciliation the provisioner should apply to bring EmonCMS in line with the config.</summary>
public sealed record EmonFeedPlan(IReadOnlyList<CreateFeed> Creates, IReadOnlyList<LinkFeed> Links, IReadOnlyList<RenameFeed> Renames);

/// <summary>
/// Decides, from the current readings + EmonCMS inputs/feeds, which feeds to create, which inputs to log
/// into an existing feed, and which feeds to rename (#163). Pure and deterministic; the HTTP work lives in
/// the provisioner. Correlation is via the canonical <c>log_to_feed</c> process (id 1) in an input's
/// processlist, so an already-wired input is recognised and only its feed's name is kept in sync.
/// </summary>
public static class EmonCmsFeedPlanner
{
    /// <summary>The EmonCMS process id of <c>log_to_feed</c> — stable across EmonCMS versions.</summary>
    public const string LogToFeedProcess = "1";

    public static EmonFeedPlan Plan(PduData data, Config config, IEnumerable<EmonInput> inputs, IEnumerable<EmonFeed> feeds)
    {
        var f = config.EmonCMS.Feeds;
        var types = (f.Types ?? new()).Where(t => !string.IsNullOrWhiteSpace(t)).Select(t => t.Trim()).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var tag = string.IsNullOrWhiteSpace(f.Tag) ? config.EmonCMS.Node : f.Tag!;
        var engine = (int)f.Engine;
        var interval = f.IntervalSeconds;

        var inputByName = new Dictionary<string, EmonInput>(StringComparer.OrdinalIgnoreCase);
        foreach (var i in inputs) inputByName[i.Name] = i;
        var feedById = new Dictionary<int, EmonFeed>();
        foreach (var fe in feeds) feedById[fe.Id] = fe;
        var feedByName = new Dictionary<string, EmonFeed>(StringComparer.OrdinalIgnoreCase);
        foreach (var fe in feeds) feedByName[fe.Name] = fe;   // first wins; good enough for name lookup

        var creates = new List<CreateFeed>();
        var links = new List<LinkFeed>();
        var renames = new List<RenameFeed>();
        var handledInputs = new HashSet<int>();

        foreach (var r in MetricsHelper.EnumerateReadings(data))
        {
            if (types.Count > 0 && !types.Contains(r.Type))
                continue;

            var inputName = MetricsHelper.EmonCmsInputName(r, config);
            if (!inputByName.TryGetValue(inputName, out var input) || !handledInputs.Add(input.Id))
                continue;   // input not posted yet, or already planned for

            var feedName = MetricsHelper.EmonCmsFeedName(r, config);

            // Already logging to a feed? Keep that feed's name in sync with the (possibly renamed) source.
            if (LinkedFeedId(input.ProcessList) is { } linkedId && feedById.TryGetValue(linkedId, out var linked))
            {
                if (!string.Equals(linked.Name, feedName, StringComparison.Ordinal))
                    renames.Add(new RenameFeed(linkedId, linked.Name, feedName));
                continue;
            }

            // Not linked yet: reuse a feed already named this, else create one.
            if (feedByName.TryGetValue(feedName, out var existing))
                links.Add(new LinkFeed(input.Id, existing.Id, inputName, feedName));
            else
                creates.Add(new CreateFeed(input.Id, inputName, feedName, tag, engine, interval));
        }

        return new EmonFeedPlan(creates, links, renames);
    }

    /// <summary>The feed id an input's processlist logs to (its first <c>log_to_feed</c>), or null.</summary>
    public static int? LinkedFeedId(string? processList)
    {
        if (string.IsNullOrWhiteSpace(processList)) return null;
        foreach (var pair in processList.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var parts = pair.Split(':', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            if (parts.Length == 2 && parts[0] == LogToFeedProcess && int.TryParse(parts[1], out var id))
                return id;
        }
        return null;
    }

    /// <summary>Add a <c>log_to_feed:&lt;feedId&gt;</c> to an existing processlist without dropping other processes.</summary>
    public static string WithLogToFeed(string? processList, int feedId)
    {
        var entry = $"{LogToFeedProcess}:{feedId}";
        return string.IsNullOrWhiteSpace(processList) ? entry : processList.Trim().TrimEnd(',') + "," + entry;
    }
}
