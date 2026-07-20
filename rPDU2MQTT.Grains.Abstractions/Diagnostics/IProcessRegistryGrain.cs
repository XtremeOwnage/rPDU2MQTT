namespace rPDU2MQTT.Grains.Abstractions.Diagnostics;

/// <summary>EmonCMS export health carried on a process's registration (only the exporter process sets it).</summary>
[GenerateSerializer]
public sealed record EmonCmsReport
{
    [Id(0)] public bool? Ok { get; init; }
    [Id(1)] public DateTime? LastSuccessUtc { get; init; }
    [Id(2)] public string? LastError { get; init; }
    [Id(3)] public int Count { get; init; }
}

/// <summary>One role process's self-report — what the GUI Status board lists in a split deployment.</summary>
[GenerateSerializer]
public sealed record ProcessInfo
{
    [Id(0)] public string Id { get; init; } = "";
    [Id(1)] public string[] Roles { get; init; } = System.Array.Empty<string>();
    [Id(2)] public string? Host { get; init; }
    [Id(3)] public DateTime StartedUtc { get; init; }
    [Id(4)] public string? Version { get; init; }
    [Id(5)] public DateTime TimestampUtc { get; init; }
    [Id(6)] public EmonCmsReport? EmonCms { get; init; }
}

/// <summary>
/// The cluster-wide process registry (singleton, key 0) — replaces the MQTT <c>HeartbeatService</c> beacons.
/// Each process registers itself on a timer; the GUI reads the live set. Orleans membership already tracks
/// silos, but this keeps the app's role labels + EmonCMS status the Status board shows.
/// </summary>
public interface IProcessRegistryGrain : IGrainWithIntegerKey
{
    /// <summary>A process a consumer marks stale once its last registration is older than this.</summary>
    const int StaleAfterSeconds = 45;

    /// <summary>Record/refresh a process's self-report.</summary>
    Task Register(ProcessInfo info);

    /// <summary>Every process registered recently (long-dead ones are pruned).</summary>
    Task<List<ProcessInfo>> Active();
}
