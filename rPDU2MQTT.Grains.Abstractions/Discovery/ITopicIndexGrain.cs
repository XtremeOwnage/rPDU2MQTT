namespace rPDU2MQTT.Grains.Abstractions.Discovery;

/// <summary>One topic the broker was seen carrying, and the last payload it carried.</summary>
[GenerateSerializer]
public sealed record TopicSample
{
    [Id(0)] public string Topic { get; init; } = "";
    [Id(1)] public string? Payload { get; init; }
    [Id(2)] public DateTime SeenUtc { get; init; }
}

/// <summary>What the index is currently doing — shown to whoever asked for it.</summary>
[GenerateSerializer]
public sealed record TopicIndexState
{
    /// <summary>A process has the broker subscription open and is feeding this index.</summary>
    [Id(0)] public bool Listening { get; init; }

    /// <summary>How many distinct topics are held right now.</summary>
    [Id(1)] public int Topics { get; init; }

    /// <summary>The cap — the index stops growing here rather than following a chatty broker forever.</summary>
    [Id(2)] public int Capacity { get; init; }
}

/// <summary>
/// A browsable index of what's on the broker (singleton, key 0), for the Nodes editor's topic autocomplete.
/// <para>
/// It exists <b>only while someone is looking</b>. A reader calls <see cref="Renew"/> while the editor is
/// open, which leases the index for a short window; the process holding the broker connection polls
/// <see cref="Wanted"/> and subscribes only during that lease, unsubscribing when it lapses. The grain drops
/// everything it holds and deactivates once the lease expires, and it is capped while it lives — so
/// browsing costs a subscription for as long as you browse, and nothing at all afterwards. That is the whole
/// design constraint: no permanent background indexer quietly accumulating every topic on the broker.
/// </para>
/// </summary>
public interface ITopicIndexGrain : IGrainWithIntegerKey
{
    /// <summary>Ask for (and keep) a live index. Called by a reader while it's browsing.</summary>
    Task<TopicIndexState> Renew();

    /// <summary>Is anyone still browsing? Polled by the process that owns the broker connection.</summary>
    Task<bool> Wanted();

    /// <summary>Record what the broker was seen carrying. An empty batch still counts as "I'm listening".</summary>
    Task Observe(List<TopicSample> samples);

    /// <summary>Topics matching a query (substring, case-insensitive), shortest first. Renews the lease.</summary>
    Task<List<TopicSample>> Search(string? query, int limit);

    /// <summary>The last payload seen on one topic, if it's in the index.</summary>
    Task<TopicSample?> Get(string topic);
}
