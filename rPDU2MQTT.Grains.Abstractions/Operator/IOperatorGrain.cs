namespace rPDU2MQTT.Grains.Abstractions.Operator;

/// <summary>
/// The operator's update report — held in the grain and returned to callers, replacing the round-trip
/// through the CR <c>status</c> the GUI used to poll. Property names are the camelCase the GUI already reads.
/// </summary>
[GenerateSerializer]
public sealed record OperatorReport
{
    [Id(0)] public bool Available { get; init; }
    [Id(1)] public string? Current { get; init; }
    [Id(2)] public string? Latest { get; init; }
    [Id(3)] public string? Policy { get; init; }
    [Id(4)] public bool AutoUpdate { get; init; }
    [Id(5)] public string? Applied { get; init; }
    [Id(6)] public string? CheckedAt { get; init; }
    [Id(7)] public string? Message { get; init; }
}

/// <summary>
/// The Kubernetes operator as a single-activation grain (key 0), replacing the OperatorService hosted loop +
/// the MQTT command topics + CR-status polling (#210). Update checks and deploy actions are now grain calls
/// that return results directly. Only does real work with the Kubernetes config source.
/// </summary>
public interface IOperatorGrain : IGrainWithIntegerKey
{
    /// <summary>Run an update check. <paramref name="force"/> bypasses the interval throttle (the GUI "check now").</summary>
    Task<OperatorReport> CheckNow(bool force);

    /// <summary>The latest report without running a check.</summary>
    Task<OperatorReport> Status();

    /// <summary>Roll the Deployment(s) to a channel/version tag. Returns a human-readable result.</summary>
    Task<string> SetTag(string tag);

    /// <summary>Re-pull the current tag now (digest-pinned). Returns a human-readable result.</summary>
    Task<string> Redeploy();
}
