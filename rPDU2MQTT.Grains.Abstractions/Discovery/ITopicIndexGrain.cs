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

    /// <summary>The topic filter currently being browsed (e.g. <c>#</c> or <c>solar_assistant/#</c>).</summary>
    [Id(3)] public string Filter { get; init; } = "#";

    /// <summary>
    /// Did the broker grant the subscription? <c>null</c> = not answered yet, <c>true</c> = granted,
    /// <c>false</c> = denied (an ACL that forbids the wildcard — the usual reason a browse stays empty on an
    /// otherwise-working broker).
    /// </summary>
    [Id(4)] public bool? Granted { get; init; }
}

/// <summary>
/// A browsable index of what's on the broker (singleton, key 0), for the Nodes editor's topic autocomplete.
/// <para>
/// It exists <b>only while someone is looking</b>. A reader calls <see cref="Renew"/> while the editor is
/// open, which leases the index for a short window; the process holding the broker connection polls
/// <see cref="Wanted"/> / <see cref="DesiredFilter"/> and subscribes only during that lease, unsubscribing
/// when it lapses. So browsing costs a subscription for as long as you browse, and nothing at all afterwards.
/// </para>
/// </summary>
public interface ITopicIndexGrain : IGrainWithIntegerKey
{
    /// <summary>
    /// Ask for (and keep) a live index of the given topic filter. <paramref name="filter"/> defaults to
    /// <c>#</c> (everything); narrow it (e.g. <c>solar_assistant/#</c>) when a broker's ACL forbids the bare
    /// wildcard. Changing the filter re-subscribes and clears what was held for the old one.
    /// </summary>
    Task<TopicIndexState> Renew(string? filter);

    /// <summary>Is anyone still browsing? Polled by the process that owns the broker connection.</summary>
    Task<bool> Wanted();

    /// <summary>The filter to subscribe to right now, or empty when nobody is browsing.</summary>
    Task<string> DesiredFilter();

    /// <summary>The subscriber reports whether the broker granted the subscription (SUBACK), so a denied ACL is visible rather than a silent empty list.</summary>
    Task ReportSubscription(bool granted);

    /// <summary>Record what the broker was seen carrying. An empty batch still counts as "I'm listening".</summary>
    Task Observe(List<TopicSample> samples);

    /// <summary>Topics matching a query (substring, case-insensitive), shortest first. Renews the lease.</summary>
    Task<List<TopicSample>> Search(string? query, int limit);

    /// <summary>
    /// Every topic currently held whose name starts with <paramref name="prefix"/> — uncapped, unordered by
    /// relevance.
    ///
    /// <para>
    /// Separate from <see cref="Search"/> because the two want opposite things. Search is a browse: it caps
    /// at a couple of hundred and puts the shortest topics first, because a human typing into an autocomplete
    /// wants the closest match, not a complete inventory. A sweep that has to retract <em>every</em> retained
    /// discovery message wants exactly the inventory, and quietly receiving the first two hundred by length
    /// would leave the rest behind — which is the failure the sweep exists to prevent.
    /// </para>
    /// </summary>
    Task<List<string>> TopicsUnder(string prefix);

    /// <summary>The last payload seen on one topic, if it's in the index.</summary>
    Task<TopicSample?> Get(string topic);
}
