using rPDU2MQTT.Grains.Abstractions.Discovery;

namespace rPDU2MQTT.Grains.Discovery;

/// <summary>
/// The browsable topic index (singleton, key 0) — see <see cref="ITopicIndexGrain"/> for why it's leased.
/// <para>
/// Two bounds keep it from becoming the thing it must not be. In <b>time</b>: the index lives on a lease that
/// readers renew, and when the lease lapses it drops everything and deactivates, so nothing survives the page
/// being closed. In <b>size</b>: it holds at most <see cref="Capacity"/> topics and evicts the least recently
/// seen, so even a firehose broker can't grow it without limit while someone is browsing.
/// </para>
/// </summary>
public sealed class TopicIndexGrain : Grain, ITopicIndexGrain
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
    private IGrainTimer? timer;

    public Task<TopicIndexState> Renew()
    {
        leaseUntilUtc = DateTime.UtcNow + Lease;
        // KeepAlive so the lease can actually expire on its own — that expiry is what frees everything.
        timer ??= this.RegisterGrainTimer(TickAsync, new GrainTimerCreationOptions(Tick, Tick) { KeepAlive = true });
        return Task.FromResult(State());
    }

    public Task<bool> Wanted() => Task.FromResult(DateTime.UtcNow < leaseUntilUtc);

    public Task Observe(List<TopicSample> samples)
    {
        lastObservedUtc = DateTime.UtcNow;

        // Don't accumulate for a reader that has already gone away.
        if (DateTime.UtcNow >= leaseUntilUtc) return Task.CompletedTask;

        foreach (var sample in samples)
            if (!string.IsNullOrEmpty(sample.Topic))
                topics[sample.Topic] = sample;

        Trim();
        return Task.CompletedTask;
    }

    public Task<List<TopicSample>> Search(string? query, int limit)
    {
        leaseUntilUtc = DateTime.UtcNow + Lease;   // searching is browsing: keep it alive
        timer ??= this.RegisterGrainTimer(TickAsync, new GrainTimerCreationOptions(Tick, Tick) { KeepAlive = true });

        var q = (query ?? "").Trim();
        var matches = topics.Values
            .Where(t => q.Length == 0 || t.Topic.Contains(q, StringComparison.OrdinalIgnoreCase))
            // Shortest first: the closest match to what was typed, rather than the deepest topic tree.
            .OrderBy(t => t.Topic.Length)
            .ThenBy(t => t.Topic, StringComparer.OrdinalIgnoreCase)
            .Take(Math.Clamp(limit, 1, 200))
            .ToList();

        return Task.FromResult(matches);
    }

    public Task<TopicSample?> Get(string topic)
        => Task.FromResult(topics.TryGetValue(topic ?? "", out var sample) ? sample : null);

    private TopicIndexState State() => new()
    {
        Listening = DateTime.UtcNow - lastObservedUtc < ListeningWindow,
        Topics = topics.Count,
        Capacity = Capacity,
    };

    /// <summary>Hold the newest <see cref="Capacity"/> topics; the rest are someone else's traffic.</summary>
    private void Trim()
    {
        if (topics.Count <= Capacity) return;

        foreach (var stale in topics.Values.OrderBy(t => t.SeenUtc).Take(topics.Count - Capacity).ToList())
            topics.Remove(stale.Topic);
    }

    private Task TickAsync(CancellationToken ct)
    {
        if (DateTime.UtcNow < leaseUntilUtc) return Task.CompletedTask;

        // Nobody is browsing any more: let go of everything and stop existing.
        topics.Clear();
        timer?.Dispose();
        timer = null;
        DeactivateOnIdle();
        return Task.CompletedTask;
    }
}
