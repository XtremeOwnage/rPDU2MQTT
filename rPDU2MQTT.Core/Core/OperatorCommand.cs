using rPDU2MQTT.Helpers;

namespace rPDU2MQTT.Core;

/// <summary>
/// An on-demand request to the operator (#210), broadcast over the bus so the GUI (which runs in a
/// separate process from the operator role) can trigger an immediate registry update check — "check now"
/// from the header — instead of waiting for the next timer tick. The operator subscribes to
/// <see cref="TopicFor"/> and runs a check as soon as one arrives.
/// </summary>
public sealed record OperatorCommand(string Action, DateTime AtUtc, string? Tag = null)
{
    /// <summary>Run an update check immediately.</summary>
    public const string CheckAction = "check";

    /// <summary>Roll the managed Deployment(s) to <see cref="Tag"/> — a channel (stable/edge/dev) or a version.</summary>
    public const string SetTagAction = "set-tag";

    /// <summary>Re-pull the currently-deployed tag now (pins its current digest so it rolls even on IfNotPresent).</summary>
    public const string RedeployAction = "redeploy";

    /// <summary>The (non-retained) bus topic operator commands are published to.</summary>
    public static string TopicFor(string parentTopic) => MQTTHelper.JoinPaths(parentTopic, "_bus", "command", "operator");
}
