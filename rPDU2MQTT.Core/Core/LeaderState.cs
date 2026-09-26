namespace rPDU2MQTT.Core;

/// <summary>
/// Whether this process is the one that polls, publishes, accumulates and writes history. Engine services
/// read it to self-gate, so two processes never produce the same output — without knowing what keeps it set.
///
/// <para>
/// A single process is always the leader. Where a leader lease is in use (#506) the flag follows the lease:
/// during a rolling update the new pod starts as a <b>standby</b> — it serves the GUI and the API but
/// produces nothing — and is promoted only once the old pod lets the lease go.
/// </para>
/// </summary>
public sealed class LeaderState
{
    private volatile bool isLeader;
    private long leaderSinceTicks;

    public bool IsLeader
    {
        get => isLeader;
        set
        {
            isLeader = value;
            Interlocked.Exchange(ref leaderSinceTicks, value ? DateTime.UtcNow.Ticks : 0);
        }
    }

    /// <summary>Is leadership decided by a lease shared with other processes? False: this process is alone.</summary>
    public bool Coordinated { get; init; }

    /// <summary>When this process last became the leader, or null while it is not.</summary>
    public DateTime? LeaderSinceUtc
    {
        get
        {
            var t = Interlocked.Read(ref leaderSinceTicks);
            return t == 0 ? null : new DateTime(t, DateTimeKind.Utc);
        }
    }

    /// <summary>Why a standby is not leading, when that is worth saying — the lease store is unreachable, say.</summary>
    public string? StandbyReason { get; set; }

    /// <summary>
    /// Raised after this process becomes the leader. Anything holding state another leader may have moved
    /// on — the energy totals, the period audit — reloads it here before producing anything.
    /// </summary>
    public event Action? Promoted;

    /// <summary>
    /// Raised as this process stops leading, while it still holds the lease: the last chance to write what
    /// it has, so the next leader starts from it.
    /// </summary>
    public event Action? SteppingDown;

    /// <summary>Become the leader, and tell whoever has state to reload.</summary>
    public void Promote()
    {
        IsLeader = true;
        StandbyReason = null;
        foreach (var handler in Promoted?.GetInvocationList() ?? [])
        {
            try { ((Action)handler)(); }
            catch (Exception ex) { Serilog.Log.Warning($"Leader lease: a handler failed on promotion ({ex.Message})."); }
        }
    }

    /// <summary>Stop leading. Work checks the flag, so it stops first; then the handlers flush.</summary>
    public void Demote()
    {
        if (!IsLeader) return;
        IsLeader = false;
        foreach (var handler in SteppingDown?.GetInvocationList() ?? [])
        {
            try { ((Action)handler)(); }
            catch (Exception ex) { Serilog.Log.Warning($"Leader lease: a handler failed while stepping down ({ex.Message})."); }
        }
    }
}
