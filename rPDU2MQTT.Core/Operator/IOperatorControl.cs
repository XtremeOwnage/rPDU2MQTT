namespace rPDU2MQTT.Core.Operator;

/// <summary>
/// How a report should read at a glance. The operator knows its state exactly when it writes the message, so
/// it says so here rather than leaving the GUI to guess a colour by keyword-matching the prose (which drifts
/// the moment a message is reworded). <see cref="Info"/> is first so a blank/initial report is neutral, not
/// falsely green. Serialized as its name via <c>JsonStringEnumConverter</c>, e.g. <c>"updateAvailable"</c>.
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
/// The operator's update report — held in memory and returned to callers, replacing the round-trip through
/// the CR <c>status</c> the GUI used to poll. Property names are the camelCase the GUI already reads.
/// </summary>
public sealed record OperatorReport
{
    public bool Available { get; init; }
    public string? Current { get; init; }
    public string? Latest { get; init; }
    public string? Policy { get; init; }
    public bool AutoUpdate { get; init; }
    public string? Applied { get; init; }
    public string? CheckedAt { get; init; }
    public string? Message { get; init; }
    public OperatorSeverity Severity { get; init; }

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
    public string? AppliedAt { get; init; }
}

/// <summary>
/// The deployment operator: update checks and deploy actions, returning their results directly. The GUI
/// depends on this seam rather than on Kubernetes — outside Kubernetes there is no implementation at all,
/// and the pages that use it say so instead of failing.
/// </summary>
public interface IOperatorControl
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
