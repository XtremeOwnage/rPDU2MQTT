namespace rPDU2MQTT.Core.Discovery;

/// <summary>
/// The browsable topic index, in memory.
///
/// <para>
/// Two bounds keep it from becoming a standing background indexer.
/// In <b>time</b>: the index lives on a lease that readers renew, and once the lease lapses it drops
/// everything — asking is what starts it, and not asking is what stops it. In <b>size</b>: at most
/// <see cref="Capacity"/> topics, evicting the least recently seen, so a chatty broker cannot grow it
/// without limit.
/// </para>
/// <para>
/// Both are checked on read rather than by a timer, which does the
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
    private readonly Dictionary<string, long> changedAt = new(StringComparer.Ordinal);
    private readonly Dictionary<string, List<double>> trends = new(StringComparer.Ordinal);

    /// <summary>Most numeric readings kept per topic for its trend.</summary>
    public const int TrendLength = 60;
    private readonly object gate = new();
    private readonly SemaphoreSlim demand = new(0, 1);
    private long sequence;
    private long epoch = 1;

    private DateTime leaseUntilUtc = DateTime.MinValue;
    private DateTime lastObservedUtc = DateTime.MinValue;
    private string filter = "#";
    private bool? granted;

    public TopicIndexState Renew(string? filter)
    {
        lock (gate)
        {
            var idle = DateTime.UtcNow >= leaseUntilUtc;
            // A blank filter means "just renew, keep browsing what I'm browsing" (the detail lookups do this),
            // so it never resets a narrowed filter back to '#'. A non-blank, different filter re-subscribes.
            if (!string.IsNullOrWhiteSpace(filter) && filter!.Trim() != this.filter)
            {
                this.filter = filter.Trim();
                Clear();
                idle = true;
            }

            leaseUntilUtc = DateTime.UtcNow + Lease;
            if (idle) Wake();
            return State();
        }
    }

    /// <summary>Waits until a reader starts browsing or changes the filter, or the timeout passes.</summary>
    public async Task WaitForDemandAsync(TimeSpan timeout, CancellationToken cancellationToken)
    {
        try { await demand.WaitAsync(timeout, cancellationToken); }
        catch (OperationCanceledException) { }
    }

    private void Wake()
    {
        if (demand.CurrentCount == 0)
            try { demand.Release(); } catch (SemaphoreFullException) { }
    }

    private void Clear()
    {
        topics.Clear();
        changedAt.Clear();
        trends.Clear();
        granted = null;
        lastObservedUtc = DateTime.MinValue;
        epoch++;
    }

    public bool Wanted()
    {
        lock (gate)
        {
            // Checked on read rather than by a timer. An expired lease frees everything it was holding here,
            // which is the whole point of leasing it: nobody browsing means nothing indexed and nothing
            // subscribed. Nothing has to notice: the lease is checked when someone looks.
            if (DateTime.UtcNow >= leaseUntilUtc && topics.Count > 0)
                Clear();
            return DateTime.UtcNow < leaseUntilUtc;
        }
    }

    public string DesiredFilter()
    {
        lock (gate) return DateTime.UtcNow < leaseUntilUtc ? filter : "";
    }

    public void ReportSubscription(bool granted)
    {
        lock (gate) this.granted = granted;
    }

    public void Observe(List<TopicSample> samples)
    {
        lock (gate)
        {
            lastObservedUtc = DateTime.UtcNow;

            // Don't accumulate for a reader that has already gone away.
            if (DateTime.UtcNow >= leaseUntilUtc) return;

            if (samples.Count > 0) sequence++;
            foreach (var sample in samples)
                if (!string.IsNullOrEmpty(sample.Topic))
                {
                    var total = (topics.TryGetValue(sample.Topic, out var prev) ? prev.Messages : 0) + Math.Max(1, sample.Messages);
                    topics[sample.Topic] = sample with { Messages = total };
                    changedAt[sample.Topic] = sequence;
                    if (Flow.TopicSampleAnalyzer.Analyze(sample.Topic, sample.Payload).Value is double v && double.IsFinite(v))
                    {
                        if (!trends.TryGetValue(sample.Topic, out var trend)) trends[sample.Topic] = trend = new List<double>();
                        trend.Add(v);
                        if (trend.Count > TrendLength) trend.RemoveRange(0, trend.Count - TrendLength);
                    }
                }

            Trim();
        }
    }

    /// <summary>
    /// The topics that changed after <paramref name="since"/>, with the cursor to ask from next time.
    /// A reader that saw a different <see cref="TopicChanges.Epoch"/> must start over: the index was cleared.
    /// </summary>
    public TopicChanges Changes(long since, string? epochSeen = null)
    {
        lock (gate)
        {
            leaseUntilUtc = DateTime.UtcNow + Lease;
            var reset = epochSeen != epoch.ToString();
            var from = reset ? 0 : since;
            var changed = changedAt
                .Where(kv => kv.Value > from)
                .Select(kv => topics[kv.Key])
                .OrderBy(t => t.Topic, StringComparer.OrdinalIgnoreCase)
                .ToList();
            return new TopicChanges { Topics = changed, Cursor = sequence, Epoch = epoch.ToString(), Reset = reset, State = State() };
        }
    }

    /// <summary>Does <paramref name="topic"/> fall under the MQTT subscription filter (with + and # wildcards)?</summary>
    public static bool FilterMatches(string filter, string topic)
    {
        if (string.IsNullOrEmpty(filter) || filter == "#") return true;
        var f = filter.Split('/');
        var t = topic.Split('/');
        for (var i = 0; i < f.Length; i++)
        {
            if (f[i] == "#") return true;
            if (i >= t.Length) return false;
            if (f[i] != "+" && f[i] != t[i]) return false;
        }
        return f.Length == t.Length;
    }

    public List<TopicSample> Search(string? query, int limit)
    {
        lock (gate)
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
    }


    public List<string> TopicsUnder(string prefix)
    {
        lock (gate)
        {
            leaseUntilUtc = DateTime.UtcNow + Lease;   // a sweep is a reader too; don't let the feed lapse mid-scan

            var p = prefix ?? "";
            return topics.Keys
                .Where(t => p.Length == 0 || t.StartsWith(p, StringComparison.OrdinalIgnoreCase))
                .ToList();
        }
    }

    /// <summary>The numeric readings seen on a topic while browsing, oldest first.</summary>
    public double[] Trend(string topic)
    {
        lock (gate) return trends.TryGetValue(topic ?? "", out var trend) ? trend.ToArray() : [];
    }

    public TopicSample? Get(string topic)
    {
        lock (gate) return topics.TryGetValue(topic ?? "", out var sample) ? sample : null;
    }

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
        {
            topics.Remove(stale.Topic);
            changedAt.Remove(stale.Topic);
            trends.Remove(stale.Topic);
        }
    }

}
