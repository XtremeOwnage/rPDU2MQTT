namespace rPDU2MQTT.Grains.Abstractions.Status;

/// <summary>How a status card reads: the colour of the dot on the Status board.</summary>
public enum StatusLevel
{
    /// <summary>Not configured — grey. Nothing is wrong; this hop simply isn't in use.</summary>
    Off,
    /// <summary>Healthy — green.</summary>
    Good,
    /// <summary>Degraded, or waiting on something — amber.</summary>
    Warn,
    /// <summary>Broken — red.</summary>
    Bad,
}

/// <summary>How the consumer should render <see cref="ComponentStatus.EventUtc"/> as a duration.</summary>
public enum AgeStyle
{
    /// <summary>No time to show.</summary>
    None,
    /// <summary>Time since the event — "Updated 2s ago".</summary>
    Ago,
    /// <summary>Time since a start — "up 1h 17m".</summary>
    Uptime,
}

/// <summary>
/// The raw facts a process reports about one component it can see (its MQTT connection, its last poll, its
/// export outcome, itself). Deliberately just facts: the component's grain owns the rule that turns them into
/// a status, so every consumer sees the same verdict.
/// </summary>
[GenerateSerializer]
public sealed record ComponentReport
{
    /// <summary>Is this component configured/turned on at all? False ⇒ the card is grey, whatever else says.</summary>
    [Id(0)] public bool Enabled { get; init; } = true;

    /// <summary>Healthy? <c>null</c> means "no outcome yet" (nothing has been attempted).</summary>
    [Id(1)] public bool? Ok { get; init; }

    /// <summary>Free text for the card's second line — a host, a topic, a port, an error.</summary>
    [Id(2)] public string? Detail { get; init; }

    /// <summary>When the thing this report describes happened (last poll, last success, process start).</summary>
    [Id(3)] public DateTime? EventUtc { get; init; }

    /// <summary>The cadence this component is expected to keep, where that decides staleness (PDU polling).</summary>
    [Id(4)] public int IntervalSeconds { get; init; }

    /// <summary>Card title, when the component is one of many of its kind (a named PDU, a node).</summary>
    [Id(5)] public string? Title { get; init; }

    /// <summary>A count worth showing — values exported, entities discovered.</summary>
    [Id(6)] public long Count { get; init; }

    /// <summary>
    /// The badge text, where only the reporter can know it — a node's role list. Components whose verdict
    /// implies its own wording ("Connected", "Stale") ignore this.
    /// </summary>
    [Id(7)] public string? State { get; init; }
}

/// <summary>
/// One card on the Status board, as computed by the component's own grain: the verdict (<see cref="Level"/> +
/// <see cref="State"/>), the supporting detail, and the instant the consumer should age for the "…ago" text.
/// Everything time-dependent is left as an instant so the card doesn't go out of date between publishes.
/// </summary>
[GenerateSerializer]
public sealed record ComponentStatus
{
    [Id(0)] public string Id { get; init; } = "";
    [Id(1)] public string Title { get; init; } = "";
    [Id(2)] public StatusLevel Level { get; init; }

    /// <summary>The short verdict shown as the card's badge — "Connected", "Polling", "Stale".</summary>
    [Id(3)] public string State { get; init; } = "";

    /// <summary>
    /// The static part of the second line ("Updated", "Topic: homeassistant", an error). Where
    /// <see cref="Age"/> is set, the consumer appends the aged <see cref="EventUtc"/> to it — so the card
    /// reads "Updated 2s ago" without the text needing to be re-published every second.
    /// </summary>
    [Id(4)] public string? Detail { get; init; }

    [Id(5)] public DateTime? EventUtc { get; init; }
    [Id(6)] public AgeStyle Age { get; init; }

    /// <summary>When this verdict was last computed.</summary>
    [Id(7)] public DateTime UpdatedUtc { get; init; }

    /// <summary>Sort key for the board, owned by the component type (broker first, nodes last).</summary>
    [Id(8)] public int Order { get; init; }
}
