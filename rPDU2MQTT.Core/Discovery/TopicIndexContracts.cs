namespace rPDU2MQTT.Core.Discovery;

/// <summary>One topic the broker was seen carrying, and the last payload it carried.</summary>
public sealed record TopicSample
{
    public string Topic { get; init; } = "";
    public string? Payload { get; init; }
    public DateTime SeenUtc { get; init; }
}

/// <summary>What the index is currently doing — shown to whoever asked for it.</summary>
public sealed record TopicIndexState
{
    /// <summary>Something has the broker subscription open and is feeding this index.</summary>
    public bool Listening { get; init; }

    /// <summary>How many distinct topics are held right now.</summary>
    public int Topics { get; init; }

    /// <summary>The cap — the index stops growing here rather than following a chatty broker forever.</summary>
    public int Capacity { get; init; }

    /// <summary>The topic filter currently being browsed (e.g. <c>#</c> or <c>solar_assistant/#</c>).</summary>
    public string Filter { get; init; } = "#";

    /// <summary>
    /// Did the broker grant the subscription? <c>null</c> = not answered yet, <c>true</c> = granted,
    /// <c>false</c> = denied — an ACL forbidding the wildcard, which is the usual reason a browse stays
    /// empty on an otherwise-working broker, and worth saying rather than showing nothing.
    /// </summary>
    public bool? Granted { get; init; }
}
