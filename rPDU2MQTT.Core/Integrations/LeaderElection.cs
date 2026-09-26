namespace rPDU2MQTT.Core.Integrations;

/// <summary>
/// Where a leader lease is kept: a key with an expiry, set only if free, extended and deleted only by the
/// process that holds it. Redis/Valkey is the implementation; a test uses a dictionary.
/// </summary>
public interface ILeaseStore
{
    /// <summary>Take the key for <paramref name="owner"/> if nobody holds it. True when taken.</summary>
    bool TryAcquire(string key, string owner, TimeSpan ttl);

    /// <summary>Extend the key's expiry if <paramref name="owner"/> still holds it. False when it does not.</summary>
    bool Renew(string key, string owner, TimeSpan ttl);

    /// <summary>Delete the key if <paramref name="owner"/> holds it; leave someone else's alone.</summary>
    void Release(string key, string owner);

    /// <summary>Who holds the key now, or null.</summary>
    string? Holder(string key);
}

/// <summary>
/// One cluster-wide leader, decided by a lease (#506).
///
/// <para>
/// Every step is a single store operation and a decision, driven by <see cref="Tick"/> so the rules can be
/// tested against a fake store and a fixed clock. The rules, in the order they matter:
/// </para>
/// <list type="bullet">
/// <item>Never two leaders. A leader that cannot prove it still holds the lease — the renewal failed, or the
/// store has not answered for most of the lease's life — stops leading before the lease can expire under it.</item>
/// <item>A standby does not take the lease until it can do the work (<c>mayLead</c>): a pod still connecting
/// to the broker would otherwise take over and publish nothing.</item>
/// <item>A leader killed without warning blocks its replacement for one lease at most: the key expires.</item>
/// </list>
/// </summary>
public sealed class LeaderElection
{
    private readonly ILeaseStore store;
    private readonly LeaderState state;
    private readonly Func<DateTime> clock;
    private readonly Action<string> log;
    private DateTime lastRenewedUtc;

    public LeaderElection(ILeaseStore store, LeaderState state, string key, string owner, TimeSpan ttl,
                          Func<DateTime>? clock = null, Action<string>? log = null)
    {
        this.store = store;
        this.state = state;
        Key = key;
        Owner = owner;
        Ttl = ttl < TimeSpan.FromSeconds(3) ? TimeSpan.FromSeconds(3) : ttl;
        this.clock = clock ?? (() => DateTime.UtcNow);
        this.log = log ?? (m => Serilog.Log.Information(m));
    }

    public string Key { get; }
    public string Owner { get; }
    public TimeSpan Ttl { get; }

    /// <summary>How often a leader renews: a third of the lease, so two renewals can fail before it lapses.</summary>
    public TimeSpan RenewEvery => Ttl / 3;

    /// <summary>How often a standby looks for a free lease. Short: this is the handover gap.</summary>
    public static readonly TimeSpan AcquireEvery = TimeSpan.FromSeconds(1);

    /// <summary>
    /// Past this since the last successful renewal, a leader stops: the lease may be about to expire, and
    /// another process may take it the moment it does.
    /// </summary>
    public TimeSpan GiveUpAfter => Ttl * 2 / 3;

    /// <summary>One step. Returns how long to wait before the next.</summary>
    public TimeSpan Tick(bool mayLead)
    {
        var now = clock();
        if (state.IsLeader)
        {
            try
            {
                if (store.Renew(Key, Owner, Ttl))
                {
                    lastRenewedUtc = now;
                    return RenewEvery;
                }
                log($"Leader lease: {Key} is no longer held by this process; stopping as leader.");
                state.StandbyReason = "the lease was lost";
                state.Demote();
                return AcquireEvery;
            }
            catch (Exception ex)
            {
                if (now - lastRenewedUtc >= GiveUpAfter)
                {
                    log($"Leader lease: could not renew {Key} for {(now - lastRenewedUtc).TotalSeconds:0}s ({ex.Message}); "
                      + "stopping as leader, since another process may take it when it expires.");
                    state.StandbyReason = $"the lease store is unreachable ({ex.Message})";
                    state.Demote();
                }
                return AcquireEvery;
            }
        }

        if (!mayLead)
        {
            state.StandbyReason = "not ready to lead yet";
            return AcquireEvery;
        }

        try
        {
            if (store.TryAcquire(Key, Owner, Ttl))
            {
                lastRenewedUtc = now;
                log($"Leader lease: took {Key}; this process now polls, publishes and records.");
                state.Promote();
                return RenewEvery;
            }
            state.StandbyReason = null;   // another process leads, which is the normal state of a standby
            return AcquireEvery;
        }
        catch (Exception ex)
        {
            state.StandbyReason = $"the lease store is unreachable ({ex.Message})";
            return AcquireEvery + AcquireEvery;
        }
    }

    /// <summary>
    /// Stop leading and let the lease go, so a standby takes over at once instead of when it expires.
    /// The flush handlers run while the lease is still held.
    /// </summary>
    public void Resign()
    {
        if (!state.IsLeader) return;
        state.Demote();
        try
        {
            store.Release(Key, Owner);
            log($"Leader lease: released {Key}.");
        }
        catch (Exception ex) { log($"Leader lease: could not release {Key} ({ex.Message}); it expires within {Ttl.TotalSeconds:0}s."); }
    }
}

/// <summary>
/// "Run only on the leader": the <see cref="ISingleOwnerLease"/> for a process that may be one of several.
/// Every key is owned by whichever process holds the leader lease, so polling a gateway that accepts one
/// client, and every other single-owner job, moves with it in one handover.
/// </summary>
public sealed class LeaderGatedLease(LeaderState leader) : ISingleOwnerLease
{
    public async Task<bool> RunIfOwnerAsync(string key, Func<CancellationToken, Task> work, CancellationToken ct)
    {
        if (!leader.IsLeader) return false;
        await work(ct);
        return true;
    }
}
