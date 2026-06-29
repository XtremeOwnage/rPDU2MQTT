namespace rPDU2MQTT.Core;

/// <summary>
/// A liveness beacon one role process publishes about itself (#127), so the GUI can show every process in
/// a split deployment — including ones that carry no PDU data (e.g. an <c>api</c> node). Liveness is by
/// freshness: a process whose last heartbeat is older than <see cref="StaleAfterSeconds"/> is presumed gone.
/// </summary>
public sealed record Heartbeat(string Id, string[] Roles, string? Host, DateTime StartedUtc, DateTime TimestampUtc, string? Version)
{
    /// <summary>Heartbeats are published this often.</summary>
    public const int IntervalSeconds = 15;

    /// <summary>A process with no heartbeat in this long is considered gone.</summary>
    public const int StaleAfterSeconds = IntervalSeconds * 3;
}
