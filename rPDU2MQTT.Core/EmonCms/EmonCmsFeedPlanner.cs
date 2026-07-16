using rPDU2MQTT.Classes;
using rPDU2MQTT.Helpers;
using rPDU2MQTT.Models.PDU;

namespace rPDU2MQTT.Core.EmonCms;

/// <summary>An EmonCMS input as returned by <c>input/get_inputs</c>: its id, key and processlist.</summary>
public sealed record EmonInput(int Id, string Name, string ProcessList);

/// <summary>An EmonCMS feed as returned by <c>feed/list</c>.</summary>
public sealed record EmonFeed(int Id, string Name, string? Tag, string? ProcessList = null);

/// <summary>A feed we want to exist. DataType 1 = realtime, 2 = daily (kWh/d).</summary>
public sealed record DesiredFeed(string Name, string Tag, int Engine, int IntervalSeconds, int DataType);

/// <summary>An input we want logged to its storage feed (and, when set, a daily kWh/d feed).</summary>
public sealed record DesiredInputLog(string InputName, string StorageFeed, string? DailyFeed);

/// <summary>A friendly virtual feed sourced from a storage feed.</summary>
public sealed record DesiredVirtualFeed(string Name, string Tag, string SourceFeed);

/// <summary>The full set of EmonCMS objects the config wants, before reconciling against what exists.</summary>
public sealed record EmonDesiredState(
    IReadOnlyList<DesiredFeed> Feeds,
    IReadOnlyList<DesiredInputLog> Inputs,
    IReadOnlyList<DesiredVirtualFeed> Virtuals);

/// <summary>The resolved process ids the planner/provisioner build processlists from.</summary>
public sealed record EmonProcessIds(string LogToFeed, string? KwhToKwhd, string? SourceFeed);

/// <summary>
/// Computes, purely from the readings + config, the EmonCMS feeds/processlists/virtual-feeds we want (#163).
/// Storage feeds are named idempotently (stable ids) so they don't churn on a rename; a daily energy type
/// adds a second daily feed; virtual feeds carry the friendly name and source from the storage feed. The
/// provisioner diffs this against what exists and applies the difference (feed ids come from EmonCMS).
/// </summary>
public static class EmonCmsFeedPlanner
{
    public static EmonDesiredState BuildDesired(PduData data, Config config)
    {
        var f = config.EmonCMS.Feeds;
        var tag = string.IsNullOrWhiteSpace(f.Tag) ? config.EmonCMS.Node : f.Tag!;
        var byType = new Dictionary<string, Models.Config.EmonCmsFeedTypeConfig>(StringComparer.OrdinalIgnoreCase);
        foreach (var t in f.Types) if (!string.IsNullOrWhiteSpace(t.Type)) byType[t.Type.Trim()] = t;

        var feeds = new Dictionary<string, DesiredFeed>(StringComparer.Ordinal);
        var inputs = new List<DesiredInputLog>();
        var virtuals = new Dictionary<string, DesiredVirtualFeed>(StringComparer.Ordinal);
        var seenInputs = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var r in MetricsHelper.EnumerateReadings(data))
        {
            if (!byType.TryGetValue(r.Type, out var typeCfg))
                continue;
            var inputName = MetricsHelper.EmonCmsInputName(r, config);
            if (!seenInputs.Add(inputName))
                continue;

            var engine = (int)(typeCfg.Engine ?? f.Engine);          // per-type override, else the Feeds default
            var interval = typeCfg.IntervalSeconds ?? f.IntervalSeconds;

            var storageName = MetricsHelper.EmonCmsStorageFeedName(r, config);
            feeds[storageName] = new DesiredFeed(storageName, tag, engine, interval, DataType: 1);

            string? dailyName = null;
            if (typeCfg.Daily)
            {
                dailyName = storageName + (f.IdempotentNames ? "_d" : " kWh/d");
                feeds[dailyName] = new DesiredFeed(dailyName, tag, engine, typeCfg.DailyIntervalSeconds, DataType: 2);
            }

            inputs.Add(new DesiredInputLog(inputName, storageName, dailyName));

            if (f.Virtual.Enabled)
            {
                var friendly = MetricsHelper.EmonCmsVirtualFeedName(r, config);
                var virtualTag = string.IsNullOrWhiteSpace(f.Virtual.Tag) ? tag : f.Virtual.Tag!;
                // Skip if the friendly feed would collide with the storage feed (same name AND tag).
                if (!(string.Equals(friendly, storageName, StringComparison.Ordinal) && string.Equals(virtualTag, tag, StringComparison.Ordinal)))
                    virtuals[friendly] = new DesiredVirtualFeed(friendly, virtualTag, storageName);
            }
        }

        return new EmonDesiredState(feeds.Values.ToList(), inputs, virtuals.Values.ToList());
    }

    /// <summary>The feed id an input's processlist logs to (its first <c>log_to_feed</c>), or null.</summary>
    public static int? LinkedFeedId(string? processList, string logToFeedProcess)
    {
        if (string.IsNullOrWhiteSpace(processList)) return null;
        foreach (var pair in processList.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var parts = pair.Split(':', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            if (parts.Length == 2 && parts[0] == logToFeedProcess && int.TryParse(parts[1], out var id))
                return id;
        }
        return null;
    }

    /// <summary>
    /// Build the processlist for an input: <c>log_to_feed:&lt;storage&gt;</c>, then <c>kwh_to_kwhd:&lt;daily&gt;</c>
    /// when a daily feed + process id are configured. Matches the two-step energy pattern in EmonCMS.
    /// </summary>
    public static string BuildInputProcessList(int storageFeedId, int? dailyFeedId, EmonProcessIds processes)
    {
        var list = $"{processes.LogToFeed}:{storageFeedId}";
        if (dailyFeedId is { } daily && !string.IsNullOrWhiteSpace(processes.KwhToKwhd))
            list += $",{processes.KwhToKwhd}:{daily}";
        return list;
    }
}
