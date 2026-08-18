using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Integrations;
using rPDU2MQTT.Core.Discovery;

namespace rPDU2MQTT.Hosting;

/// <summary>
/// The broker's topics offered as nodes to adopt — <see cref="INodeProvider"/> over the topic index that
/// already backs the GUI's "Browse broker topics" picker.
///
/// <para>
/// This is what that capability was described from: a system asked "what have you got that I could model?"
/// The index leases its subscription while someone is browsing rather than indexing in the background, so
/// asking is what starts it — which is why discovery is defined as cheap and interactive rather than as a
/// standing scan.
/// </para>
/// <para>
/// It offers and never creates. What gets adopted, what it is called and where it hangs in the hierarchy
/// stay the operator's; a discovery that wrote nodes would rewrite a hand-built diagram every time someone
/// opened a picker.
/// </para>
/// </summary>
public sealed class MqttNodeProvider : INodeProvider
{
    private readonly TopicIndex index;

    public MqttNodeProvider(TopicIndex index) => this.index = index;

    public Task<IReadOnlyList<DiscoveredNode>> DiscoverAsync(Config cfg, string? search, CancellationToken ct)
    {
        // Renewing is what keeps the subscription open: asking is browsing.
        index.Renew(null);

        // Never offer this bridge's own output. Everything under the parent topic and the Home Assistant
        // discovery prefix is what it just published; adopting one as a source feeds the bridge its own
        // readings, and on a busy broker they crowd out the third-party topics someone is actually looking
        // for — every one of the first hundred offered was our own. (The Home Assistant importer already
        // skips our own devices for the same reason.)
        // Searched wide and trimmed after filtering: the index is capped at 200 per search, and asking for
        // 100 before dropping our own would return a page of nothing else.
        var mine = Own(cfg);
        var samples = index.Search(search, 200)
            .Where(s => !IsOwn(s.Topic, mine))
            .Take(100)
            .ToList();

        var nodes = samples.Select(s =>
        {
            // What it looks like, read from the payload by the same analyzer the node editor uses — so a
            // discovered node and a hand-bound one agree about what a topic is. Nulls stay null: a wrong
            // guess presented as fact is worse than asking.
            var hint = Core.Flow.TopicSampleAnalyzer.Analyze(s.Topic, s.Payload);
            return new DiscoveredNode(
                Key: s.Topic,
                Label: s.Topic,
                Metric: hint.Metric,
                Unit: hint.Unit,
                Sample: hint.Value,
                Kind: null,
                SuggestedId: Suggest(s.Topic));
        }).ToList();
        return Task.FromResult<IReadOnlyList<DiscoveredNode>>(nodes);
    }

    /// <summary>The topic prefixes this bridge publishes under.</summary>
    private static string[] Own(Config cfg)
        => new[] { cfg.MQTT.ParentTopic, cfg.HASS.DiscoveryTopic }
            .Where(p => !string.IsNullOrWhiteSpace(p))
            .Select(p => p!.Trim().Trim('/'))
            .ToArray();

    private static bool IsOwn(string topic, string[] mine)
        => mine.Any(p => topic.Equals(p, StringComparison.OrdinalIgnoreCase)
                      || topic.StartsWith(p + "/", StringComparison.OrdinalIgnoreCase));

    /// <summary>A node id someone might reasonably accept — the last meaningful topic segment.</summary>
    private static string Suggest(string topic)
    {
        var parts = topic.Split('/', StringSplitOptions.RemoveEmptyEntries);
        // "…/pv_power/state" describes the value, not the thing: the segment before it is the better name.
        var last = parts.Length > 1 && parts[^1] is "state" or "value" ? parts[^2] : parts.LastOrDefault() ?? topic;
        return new string(last.Select(c => char.IsLetterOrDigit(c) ? char.ToLowerInvariant(c) : '_').ToArray());
    }
}
