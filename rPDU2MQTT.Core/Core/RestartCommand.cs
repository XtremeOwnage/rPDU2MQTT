using rPDU2MQTT.Helpers;

namespace rPDU2MQTT.Core;

/// <summary>
/// A restart request broadcast over the bus so a split deployment can be restarted tier-by-tier from the
/// GUI. Every process listens on <see cref="TopicFor"/>; one whose role matches the
/// <see cref="Target"/> ("all" or a role name) stops itself, and its orchestrator brings it back. In
/// Kubernetes the GUI prefers a rollout restart instead (which also pulls the latest image), so this is the
/// mechanism for non-Kubernetes split deployments.
/// </summary>
public sealed record RestartCommand(string Target, DateTime AtUtc)
{
    /// <summary>The <see cref="Target"/> value that matches every process.</summary>
    public const string TargetAll = "all";

    /// <summary>The (non-retained) bus topic restart requests are published to.</summary>
    public static string TopicFor(string parentTopic) => MQTTHelper.JoinPaths(parentTopic, "_bus", "command", "restart");

    /// <summary>Does a process running <paramref name="roles"/> match this command's target ("all" or a role name)?</summary>
    public bool MatchesRoles(IEnumerable<string> roles)
        => string.Equals(Target, TargetAll, StringComparison.OrdinalIgnoreCase)
           || roles.Any(r => string.Equals(r, Target, StringComparison.OrdinalIgnoreCase));
}
