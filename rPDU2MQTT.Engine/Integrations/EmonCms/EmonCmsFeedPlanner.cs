using rPDU2MQTT.Classes;
using rPDU2MQTT.Helpers;
using rPDU2MQTT.Models.PDU;

namespace rPDU2MQTT.Integrations.EmonCms;

/// <summary>An EmonCMS input as returned by <c>input/get_inputs</c>: its id, key and processlist.</summary>
public sealed record EmonInput(int Id, string Name, string ProcessList);

/// <summary>An EmonCMS feed as returned by <c>feed/list</c>.</summary>
public sealed record EmonFeed(int Id, string Name, string? Tag, string? ProcessList = null);

/// <summary>A feed we want to exist. DataType 1 = realtime, 2 = daily (kWh/d).</summary>
public sealed record DesiredFeed(string Name, string Tag, int Engine, int IntervalSeconds, int DataType);

/// <summary>One step of an input's processlist: the process, and the feed it writes.</summary>
public sealed record DesiredProcess(string Process, string Feed);

/// <summary>An input and the ordered processlist we want on it; order matters, as some steps rewrite the value passed on.</summary>
public sealed record DesiredInputLog(string InputName, IReadOnlyList<DesiredProcess> Steps)
{
    /// <summary>The feed the first step writes — the one a history read for this input looks up.</summary>
    public string StorageFeed => Steps[0].Feed;
}

/// <summary>A friendly virtual feed sourced from a storage feed.</summary>
public sealed record DesiredVirtualFeed(string Name, string Tag, string SourceFeed);

/// <summary>The full set of EmonCMS objects the config wants, before reconciling against what exists.</summary>
public sealed record EmonDesiredState(
    IReadOnlyList<DesiredFeed> Feeds,
    IReadOnlyList<DesiredInputLog> Inputs,
    IReadOnlyList<DesiredVirtualFeed> Virtuals);

/// <summary>
/// Computes, purely from the readings + config, the EmonCMS feeds/processlists/virtual-feeds we want (#163).
/// Storage feeds are named idempotently (stable ids) so they don't churn on a rename; a daily energy type
/// adds a second daily feed; virtual feeds carry the friendly name and source from the storage feed. The
/// provisioner diffs this against what exists and applies the difference (feed ids come from EmonCMS).
/// </summary>
public static class EmonCmsFeedPlanner
{
    /// <param name="flow">
    /// The energy-flow graphs to provision feeds for, one per exported metric (see <c>FlowTiers.Graphs</c>).
    /// Null skips them — the feeds a hierarchy needs are the ones its history is read from, so a caller that
    /// can build the graphs should pass them.
    /// </param>
    public static EmonDesiredState BuildDesired(
        PduData data, Config config, IReadOnlyList<(string Metric, Core.Flow.FlowGraph Graph)>? flow = null)
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

            var readingSteps = new List<DesiredProcess> { new(ProcessSlot.LogToFeed, storageName) };
            if (dailyName is not null) readingSteps.Add(new(ProcessSlot.KwhToKwhd, dailyName));
            inputs.Add(new DesiredInputLog(inputName, readingSteps));

            if (f.Virtual.Enabled)
            {
                var friendly = MetricsHelper.EmonCmsVirtualFeedName(r, config);
                var virtualTag = string.IsNullOrWhiteSpace(f.Virtual.Tag) ? tag : f.Virtual.Tag!;
                // Skip if the friendly feed would collide with the storage feed (same name AND tag).
                if (!(string.Equals(friendly, storageName, StringComparison.Ordinal) && string.Equals(virtualTag, tag, StringComparison.Ordinal)))
                    virtuals[friendly] = new DesiredVirtualFeed(friendly, virtualTag, storageName);
            }
        }

        // Every flow node gets power, energy and energy/d; EmonCMS derives whichever it does not report.
        if (flow is not null && config.EmonCMS.ExportFlowNodes)
        {
            // Which metrics each node sources itself; a summed or inferred value is not an input.
            var sourced = new Dictionary<string, HashSet<string>>(StringComparer.OrdinalIgnoreCase);
            var tiersOf = new Dictionary<string, Core.Flow.FlowNode>(StringComparer.OrdinalIgnoreCase);
            foreach (var (metric, graph) in flow)
                foreach (var t in Core.Flow.FlowTiers.Of(graph, config.EmonCMS.NodeTags))
                {
                    tiersOf[t.Node.Id] = t.Node;
                    if (t.Node.Derivation == Core.Flow.FlowDerivation.Measured || t.Node.Unreported)
                        (sourced.TryGetValue(t.Node.Id, out var have)
                            ? have
                            : sourced[t.Node.Id] = new HashSet<string>(StringComparer.OrdinalIgnoreCase)).Add(metric);
                }

            string powerMetric = Core.Flow.FlowGraphBuilder.DefaultMetric;
            string? energyMetric = flow.Select(x => x.Metric)
                .FirstOrDefault(m => string.Equals(Core.Flow.FlowUnits.Canonical(m), "kWh", StringComparison.Ordinal)
                                  && !string.Equals(m, Core.Flow.EnergyPeriod.Metric, StringComparison.OrdinalIgnoreCase));

            foreach (var (nodeId, node) in tiersOf)
            {
                var have = sourced.TryGetValue(nodeId, out var h) ? h : new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                var hasPower = have.Contains(powerMetric);
                var hasEnergy = energyMetric is not null && have.Contains(energyMetric);
                // Sources neither: still exported, and the power it is given is what the rest derives from.
                if (!hasPower && !hasEnergy) hasPower = true;

                string? FeedFor(string metric, int dataType, int interval)
                {
                    if (!byType.TryGetValue(metric, out var typeCfg)) return null;
                    var name = MetricsHelper.EmonCmsFlowInputName(node.Id, node.Label, node.Kind, metric, config);
                    feeds[name] = new DesiredFeed(name, tag, (int)(typeCfg.Engine ?? f.Engine),
                        interval < 0 ? typeCfg.IntervalSeconds ?? f.IntervalSeconds : interval, dataType);
                    return name;
                }

                var powerFeed = FeedFor(powerMetric, 1, -1);
                var energyFeed = energyMetric is null ? null : FeedFor(energyMetric, 1, -1);
                string? dailyFeed = null;
                if (energyMetric is not null && byType.TryGetValue(energyMetric, out var energyType) && energyType.Daily && energyFeed is not null)
                {
                    dailyFeed = energyFeed + (f.IdempotentNames ? "_d" : " kWh/d");
                    feeds[dailyFeed] = new DesiredFeed(dailyFeed, tag, (int)(energyType.Engine ?? f.Engine),
                        energyType.DailyIntervalSeconds, DataType: 2);
                }

                // kWh-to-Power is last: it hands watts to whatever follows it.
                if (hasEnergy && energyFeed is not null)
                {
                    var steps = new List<DesiredProcess> { new(ProcessSlot.KwhAccumulator, energyFeed) };
                    if (dailyFeed is not null) steps.Add(new(ProcessSlot.KwhToKwhd, dailyFeed));
                    if (!hasPower && powerFeed is not null) steps.Add(new(ProcessSlot.KwhToPower, powerFeed));
                    var name = MetricsHelper.EmonCmsFlowInputName(node.Id, node.Label, node.Kind, energyMetric!, config);
                    if (seenInputs.Add(name)) inputs.Add(new DesiredInputLog(name, steps));
                }

                // Neither derivation changes the watts passed on, so both follow the plain log.
                if (hasPower && powerFeed is not null)
                {
                    var steps = new List<DesiredProcess> { new(ProcessSlot.LogToFeed, powerFeed) };
                    if (!hasEnergy)
                    {
                        if (energyFeed is not null) steps.Add(new(ProcessSlot.PowerToKwh, energyFeed));
                        if (dailyFeed is not null) steps.Add(new(ProcessSlot.PowerToKwhd, dailyFeed));
                    }
                    var name = MetricsHelper.EmonCmsFlowInputName(node.Id, node.Label, node.Kind, powerMetric, config);
                    if (seenInputs.Add(name)) inputs.Add(new DesiredInputLog(name, steps));
                }

                if (f.Virtual.Enabled)
                    foreach (var (metric, feedName) in new (string? Metric, string? Feed)[] { (powerMetric, powerFeed), (energyMetric, energyFeed) })
                    {
                        if (metric is null || feedName is null) continue;
                        var friendly = MetricsHelper.EmonCmsFlowFeedName(node.Label, metric, config);
                        var virtualTag = string.IsNullOrWhiteSpace(f.Virtual.Tag) ? tag : f.Virtual.Tag!;
                        if (!(string.Equals(friendly, feedName, StringComparison.Ordinal) && string.Equals(virtualTag, tag, StringComparison.Ordinal)))
                            virtuals[friendly] = new DesiredVirtualFeed(friendly, virtualTag, feedName);
                    }
            }

            // Every other configured metric is logged as it arrives; only power and the counter substitute.
            foreach (var (metric, graph) in flow)
            {
                if (string.Equals(metric, powerMetric, StringComparison.OrdinalIgnoreCase)
                    || (energyMetric is not null && string.Equals(metric, energyMetric, StringComparison.OrdinalIgnoreCase)))
                    continue;
                if (!byType.TryGetValue(metric, out var typeCfg)) continue;

                foreach (var t in Core.Flow.FlowTiers.Of(graph, config.EmonCMS.NodeTags))
                {
                    var inputName = MetricsHelper.EmonCmsFlowInputName(t.Node.Id, t.Node.Label, t.Node.Kind, metric, config);
                    if (!seenInputs.Add(inputName)) continue;

                    var engine = (int)(typeCfg.Engine ?? f.Engine);
                    feeds[inputName] = new DesiredFeed(inputName, tag, engine, typeCfg.IntervalSeconds ?? f.IntervalSeconds, DataType: 1);

                    var steps = new List<DesiredProcess> { new(ProcessSlot.LogToFeed, inputName) };
                    if (typeCfg.Daily)
                    {
                        var dailyName = inputName + (f.IdempotentNames ? "_d" : " kWh/d");
                        feeds[dailyName] = new DesiredFeed(dailyName, tag, engine, typeCfg.DailyIntervalSeconds, DataType: 2);
                        steps.Add(new(ProcessSlot.KwhToKwhd, dailyName));
                    }
                    inputs.Add(new DesiredInputLog(inputName, steps));

                    if (f.Virtual.Enabled)
                    {
                        var friendly = MetricsHelper.EmonCmsFlowFeedName(t.Node.Label, metric, config);
                        var virtualTag = string.IsNullOrWhiteSpace(f.Virtual.Tag) ? tag : f.Virtual.Tag!;
                        if (!(string.Equals(friendly, inputName, StringComparison.Ordinal) && string.Equals(virtualTag, tag, StringComparison.Ordinal)))
                            virtuals[friendly] = new DesiredVirtualFeed(friendly, virtualTag, inputName);
                    }
                }
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

    /// <summary>Join the steps into <c>&lt;process&gt;:&lt;feedid&gt;</c> pairs, dropping any whose feed does not exist.</summary>
    public static string BuildInputProcessList(IReadOnlyList<DesiredProcess> steps, Func<string, int?> feedId)
        => string.Join(",", steps
            .Select(st => (st.Process, Feed: feedId(st.Feed)))
            .Where(st => st.Feed is not null)
            .Select(st => $"{st.Process}:{st.Feed}"));
}
