namespace rPDU2MQTT.Grains.Abstractions.Operator;

/// <summary>
/// How a report should read at a glance. The grain knows its state exactly when it writes the message, so it
/// says so here rather than leaving the GUI to guess a colour by keyword-matching the prose (which drifts the
/// moment a message is reworded). <see cref="Info"/> is first so a blank/initial report is neutral, not falsely
/// green. Serialized as its name via <c>JsonStringEnumConverter</c>, e.g. <c>"updateAvailable"</c>.
/// </summary>
public enum OperatorSeverity
{
    /// <summary>Neutral — checking, disabled, or couldn't determine (muted).</summary>
    Info,
    /// <summary>Running the latest eligible build (good).</summary>
    Ok,
    /// <summary>A newer build is available, or one was just applied (attention).</summary>
    UpdateAvailable,
    /// <summary>The check itself failed (muted/error).</summary>
    Error,
}

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
    [Id(8)] public OperatorSeverity Severity { get; init; }

    /// <summary>
    /// When the operator last actually rolled the deployment, ISO-8601. Null when it never has.
    ///
    /// <para>
    /// <see cref="Applied"/> alone cannot signal a roll, which is why the GUI's auto-update notice never
    /// appeared. Anyone tracking a moving tag — <c>unstable</c>, <c>main</c>, <c>edge</c>, the default and
    /// the common case — gets a new <em>digest</em> under the same tag, so <see cref="Applied"/> reads
    /// "unstable" before and after and nothing looks like it changed. Only a switch between differently
    /// named tags was ever visible.
    /// </para>
    /// <para>
    /// A timestamp of the roll itself changes every time, moving-tag or not, and is distinct from
    /// <see cref="CheckedAt"/> — which advances on every scheduled check and would announce an update once
    /// an hour whether or not anything happened.
    /// </para>
    /// </summary>
    [Id(9)] public string? AppliedAt { get; init; }
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
