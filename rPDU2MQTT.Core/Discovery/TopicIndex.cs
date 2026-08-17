namespace rPDU2MQTT.Core.Discovery;

/// <summary>
/// The browsable topic index, in memory.
///
/// <para>
/// Two bounds keep it from becoming a standing background indexer, and both survive the move off Orleans.
/// In <b>time</b>: the index lives on a lease that readers renew, and once the lease lapses it drops
/// everything — asking is what starts it, and not asking is what stops it. In <b>size</b>: at most
/// <see cref="Capacity"/> topics, evicting the least recently seen, so a chatty broker cannot grow it
/// without limit.
/// </para>
/// <para>
/// The grain version ran a ten-second timer to notice its own lease had expired. Checking on read does the
/// same job with nothing running in the background — which is the whole point of a leased index.
/// </para>
/// </summary>
public sealed class TopicIndex
{
    /// <summary>How long one Renew keeps the index alive. Readers renew while the editor is open.</summary>
    private static readonly TimeSpan Lease = TimeSpan.FromSeconds(60);

    /// <summary>A subscriber that hasn't reported in this long isn't considered to be listening.</summary>
    private static readonly TimeSpan ListeningWindow = TimeSpan.FromSeconds(20);

    private static readonly TimeSpan Tick = TimeSpan.FromSeconds(10);

    /// <summary>Most topics held at once. Past this the least recently seen are dropped.</summary>
    public const int Capacity = 2000;

    private readonly Dictionary<string, TopicSample> topics = new(StringComparer.Ordinal);

    private DateTime leaseUntilUtc = DateTime.MinValue;
    private DateTime lastObservedUtc = DateTime.MinValue;
    private string filter = "#";
    private bool? granted;

    public TopicIndexState Renew(string? filter)
    {
        // A blank filter means "just renew, keep browsing what I'm browsing" (the detail lookups do this),
        // so it never resets a narrowed filter back to '#'. A non-blank, different filter re-subscribes.
        if (!string.IsNullOrWhiteSpace(filter) && filter!.Trim() != this.filter)
        {
            this.filter = filter.Trim();
            topics.Clear();
            granted = null;
            lastObservedUtc = DateTime.MinValue;
        }

        leaseUntilUtc = DateTime.UtcNow + Lease;
        return State();
    }

    public bool Wanted()
    {
        // Checked on read rather than by a timer. An expired lease frees everything it was holding here,
        // which is the whole point of leasing it: nobody browsing means nothing indexed and nothing
        // subscribed. The grain needed a tick to notice; nothing has to notice now.
        if (DateTime.UtcNow >= leaseUntilUtc && topics.Count > 0)
        {
            topics.Clear();
            granted = null;
            lastObservedUtc = DateTime.MinValue;
        }
        return DateTime.UtcNow < leaseUntilUtc;
    }

    public string DesiredFilter() => DateTime.UtcNow < leaseUntilUtc ? filter : "";

    public void ReportSubscription(bool granted)
    {
        this.granted = granted;
    }

    public void Observe(List<TopicSample> samples)
    {
        lastObservedUtc = DateTime.UtcNow;

        // Don't accumulate for a reader that has already gone away.
        if (DateTime.UtcNow >= leaseUntilUtc) return;

        foreach (var sample in samples)
            if (!string.IsNullOrEmpty(sample.Topic))
                topics[sample.Topic] = sample;

        Trim();
    }

    public List<TopicSample> Search(string? query, int limit)
    {
        leaseUntilUtc = DateTime.UtcNow + Lease;   // searching is browsing: keep it alive

        var q = (query ?? "").Trim();
        var matches = topics.Values
            .Where(t => q.Length == 0 || t.Topic.Contains(q, StringComparison.OrdinalIgnoreCase))
            // Shortest first: the closest match to what was typed, rather than the deepest topic tree.
            .OrderBy(t => t.Topic.Length)
            .ThenBy(t => t.Topic, StringComparer.OrdinalIgnoreCase)
            .Take(Math.Clamp(limit, 1, 200))
            .ToList();

        return matches;
    }


    public List<string> TopicsUnder(string prefix)
    {
        leaseUntilUtc = DateTime.UtcNow + Lease;   // a sweep is a reader too; don't let the feed lapse mid-scan

        var p = prefix ?? "";
        return topics.Keys
            .Where(t => p.Length == 0 || t.StartsWith(p, StringComparison.OrdinalIgnoreCase))
            .ToList();
    }
    public TopicSample? Get(string topic)
        => topics.TryGetValue(topic ?? "", out var sample) ? sample : null;

    private TopicIndexState State() => new()
    {
        Listening = DateTime.UtcNow - lastObservedUtc < ListeningWindow,
        Topics = topics.Count,
        Capacity = Capacity,
        Filter = filter,
        Granted = granted,
    };

    /// <summary>Hold the newest <see cref="Capacity"/> topics; the rest are someone else's traffic.</summary>
    private void Trim()
    {
        if (topics.Count <= Capacity) return;

        foreach (var stale in topics.Values.OrderBy(t => t.SeenUtc).Take(topics.Count - Capacity).ToList())
            topics.Remove(stale.Topic);
    }

}
