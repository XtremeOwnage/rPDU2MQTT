namespace rPDU2MQTT.Classes;

/// <summary>
/// Shared liveness/readiness signals: process start time and the last successful PDU poll,
/// updated by the publishing loop and read by the health endpoints + the GUI diagnostics page.
/// </summary>
public sealed class HealthState
{
    public DateTime StartedUtc { get; } = DateTime.UtcNow;

    private long lastPollTicks; // 0 = never polled successfully

    /// <summary>Record a successful PDU poll (resets the readiness staleness window).</summary>
    public void RecordPollSuccess() => Interlocked.Exchange(ref lastPollTicks, DateTime.UtcNow.Ticks);

    public DateTime? LastPollUtc
    {
        get
        {
            var ticks = Interlocked.Read(ref lastPollTicks);
            return ticks == 0 ? null : new DateTime(ticks, DateTimeKind.Utc);
        }
    }

    public TimeSpan Uptime => DateTime.UtcNow - StartedUtc;
}
