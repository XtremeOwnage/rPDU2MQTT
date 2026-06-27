namespace rPDU2MQTT.Core;

/// <summary>
/// When a pipeline snapshot is considered too old to act on. Consumers skip stale snapshots so a
/// stalled producer (e.g. an unreachable PDU) surfaces downstream (HA expire_after) instead of being
/// masked by republished last-known values.
/// </summary>
public static class SnapshotFreshness
{
    /// <summary>A snapshot older than ~2.5 polls (min 30s) is stale.</summary>
    public static TimeSpan StaleAfter(int pollIntervalSeconds)
        => TimeSpan.FromSeconds(Math.Max(30, pollIntervalSeconds * 2.5));

    public static bool IsStale(DateTime timestampUtc, int pollIntervalSeconds, DateTime nowUtc)
        => nowUtc - timestampUtc > StaleAfter(pollIntervalSeconds);
}
