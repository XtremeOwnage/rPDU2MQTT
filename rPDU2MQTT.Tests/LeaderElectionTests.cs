using rPDU2MQTT.Classes;
using rPDU2MQTT.Core;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Core.Integrations;
using rPDU2MQTT.Services;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// The leader lease behind a graceful rollout (#506). Two processes run for the length of a rolling update,
/// and at no point may both poll, publish, accumulate or write history.
/// </summary>
public class LeaderElectionTests
{
    private static readonly TimeSpan Ttl = TimeSpan.FromSeconds(15);

    /// <summary>A lease store with Redis's rules — set-if-free, owner-checked renew and delete — on a fake clock.</summary>
    private sealed class FakeStore(Func<DateTime> clock) : ILeaseStore
    {
        private readonly Dictionary<string, (string Owner, DateTime Expires)> keys = new();
        public bool Down { get; set; }

        private void Expire(string key)
        {
            if (keys.TryGetValue(key, out var v) && v.Expires <= clock()) keys.Remove(key);
        }

        public bool TryAcquire(string key, string owner, TimeSpan ttl)
        {
            if (Down) throw new InvalidOperationException("cache is not connected");
            Expire(key);
            if (keys.ContainsKey(key)) return false;
            keys[key] = (owner, clock() + ttl);
            return true;
        }

        public bool Renew(string key, string owner, TimeSpan ttl)
        {
            if (Down) throw new InvalidOperationException("cache is not connected");
            Expire(key);
            if (!keys.TryGetValue(key, out var v) || v.Owner != owner) return false;
            keys[key] = (owner, clock() + ttl);
            return true;
        }

        public void Release(string key, string owner)
        {
            if (Down) throw new InvalidOperationException("cache is not connected");
            if (keys.TryGetValue(key, out var v) && v.Owner == owner) keys.Remove(key);
        }

        public string? Holder(string key)
        {
            Expire(key);
            return keys.TryGetValue(key, out var v) ? v.Owner : null;
        }
    }

    private DateTime now = new(2026, 9, 26, 12, 0, 0, DateTimeKind.Utc);

    private (LeaderElection Election, LeaderState State) Process(ILeaseStore store, string name)
    {
        var state = new LeaderState { Coordinated = true };
        return (new LeaderElection(store, state, "rpdu2mqtt:leader", name, Ttl, () => now, _ => { }), state);
    }

    [Fact]
    public void AStandbyDoesNotTakeTheLeaseUntilItCanLead()
    {
        var store = new FakeStore(() => now);
        var (p, state) = Process(store, "new");

        p.Tick(mayLead: false);
        Assert.False(state.IsLeader);
        Assert.Null(store.Holder("rpdu2mqtt:leader"));

        p.Tick(mayLead: true);
        Assert.True(state.IsLeader);
    }

    [Fact]
    public void OneLeaderAtATime_AndTheHandoverIsImmediateOnResign()
    {
        var store = new FakeStore(() => now);
        var (old, oldState) = Process(store, "old");
        var (next, nextState) = Process(store, "new");

        old.Tick(true);
        next.Tick(true);
        Assert.True(oldState.IsLeader);
        Assert.False(nextState.IsLeader);

        // Renewed well past the lease's length: still the one leader.
        for (var i = 0; i < 10; i++)
        {
            now += old.RenewEvery;
            old.Tick(true);
            next.Tick(true);
            Assert.True(oldState.IsLeader);
            Assert.False(nextState.IsLeader);
        }

        // SIGTERM: the old one lets go, and the standby takes it on its next look — not when it expires.
        var flushedWhileHeld = false;
        oldState.SteppingDown += () => flushedWhileHeld = store.Holder("rpdu2mqtt:leader") == "old";
        old.Resign();
        Assert.False(oldState.IsLeader);
        Assert.True(flushedWhileHeld);   // the totals are written before anyone else can start from them

        now += LeaderElection.AcquireEvery;
        next.Tick(true);
        Assert.True(nextState.IsLeader);
    }

    [Fact]
    public void ALeaderKilledWithoutWarning_IsReplacedWithinOneLease()
    {
        var store = new FakeStore(() => now);
        var (dead, _) = Process(store, "dead");
        var (next, nextState) = Process(store, "new");
        dead.Tick(true);

        // No SIGTERM, so no release and no more renewals.
        now += Ttl - TimeSpan.FromSeconds(1);
        next.Tick(true);
        Assert.False(nextState.IsLeader);

        now += TimeSpan.FromSeconds(1);
        next.Tick(true);
        Assert.True(nextState.IsLeader);
    }

    [Fact]
    public void ALeaderThatCannotRenew_StopsBeforeItsLeaseCanBeTaken()
    {
        var store = new FakeStore(() => now);
        var (old, oldState) = Process(store, "old");
        var (next, nextState) = Process(store, "new");
        old.Tick(true);

        // The old leader loses the store; the lease still expires on schedule for everyone else.
        store.Down = true;
        for (var t = TimeSpan.Zero; t <= Ttl + TimeSpan.FromSeconds(2); t += TimeSpan.FromSeconds(1))
        {
            now += TimeSpan.FromSeconds(1);
            old.Tick(true);
            store.Down = false;
            next.Tick(true);
            store.Down = true;
            Assert.False(oldState.IsLeader && nextState.IsLeader, $"two leaders at +{t.TotalSeconds}s");
        }
        Assert.False(oldState.IsLeader);
        Assert.True(nextState.IsLeader);
        Assert.Contains("unreachable", oldState.StandbyReason);
    }

    [Fact]
    public void ALeaderWhoseLeaseWasTaken_StepsDown()
    {
        var store = new FakeStore(() => now);
        var (old, oldState) = Process(store, "old");
        old.Tick(true);
        store.Release("rpdu2mqtt:leader", "old");
        store.TryAcquire("rpdu2mqtt:leader", "someone else", Ttl);

        now += old.RenewEvery;
        old.Tick(true);
        Assert.False(oldState.IsLeader);
    }

    [Fact]
    public async Task OnlyTheLeaderRunsSingleOwnerWork()
    {
        var state = new LeaderState { Coordinated = true };
        var lease = new LeaderGatedLease(state);
        var ran = 0;

        Assert.False(await lease.RunIfOwnerAsync("pdu:rack", _ => { ran++; return Task.CompletedTask; }, default));
        state.Promote();
        Assert.True(await lease.RunIfOwnerAsync("pdu:rack", _ => { ran++; return Task.CompletedTask; }, default));
        Assert.Equal(1, ran);
    }

    [Fact]
    public void AStandbyIsReady_ToTakeOver_WithoutHavingPolled()
    {
        var standby = new LeaderState { Coordinated = true };
        Assert.Null(HealthService.NotReadyReason(true, null, standby, 5, now));
        Assert.NotNull(HealthService.NotReadyReason(false, null, standby, 5, now));

        // …but not when it could not take over if asked.
        standby.StandbyReason = "the lease store is unreachable (cache is not connected)";
        Assert.Contains("cannot take over", HealthService.NotReadyReason(true, null, standby, 5, now));
    }

    [Fact]
    public void ALeaderJustPromoted_HasOneWindowForItsFirstPoll()
    {
        var leader = new LeaderState { Coordinated = true };
        leader.Promote();
        Assert.Null(HealthService.NotReadyReason(true, null, leader, 5, DateTime.UtcNow));
        Assert.NotNull(HealthService.NotReadyReason(true, null, leader, 5, DateTime.UtcNow.AddMinutes(5)));

        // A process on its own is judged as it always was.
        var alone = new LeaderState { IsLeader = true };
        Assert.NotNull(HealthService.NotReadyReason(true, null, alone, 5, DateTime.UtcNow));
    }

    [Fact]
    public void AStandbyJudgesReadings_ButLeavesTheSharedRecordToTheLeader()
    {
        var store = new CountingAuditStore();
        var leader = new LeaderState { Coordinated = true };
        var auditor = new PeriodAuditor(store, _ => { }, () => leader.IsLeader);

        auditor.Allow("pv", "mqtt", null, "2026-09-26", 1.0);
        Assert.Equal(0, store.Saves);

        leader.Promote();
        auditor.Allow("pv", "mqtt", null, "2026-09-26", 2.0);
        Assert.Equal(1, store.Saves);
    }

    [Fact]
    public void TheEnergyTotalsAreHandedOverAsTheLeaderStepsDown()
    {
        var store = new MemoryEnergyStore();
        var leader = new LeaderState { Coordinated = true };
        leader.Promote();
        store.Save(new Dictionary<string, EnergyState> { ["pv"] = EnergyState.Empty });
        var svc = new EnergyAggregationService(new Config(), new NoValues(), store, leader: leader);
        svc.LoadTotals();
        store.Save(new Dictionary<string, EnergyState>());   // as if nothing were written since

        leader.Demote();

        Assert.True(store.Load().ContainsKey("pv"));
    }

    private sealed class NoValues : IFlowValueSource
    {
        public bool TryGetValue(string node, string metric, out double value) { value = 0; return false; }
    }

    private sealed class CountingAuditStore : IPeriodAuditStore
    {
        public int Saves;
        public IReadOnlyDictionary<string, PeriodCounterAudit.State> Load() => new Dictionary<string, PeriodCounterAudit.State>();
        public void Save(IReadOnlyDictionary<string, PeriodCounterAudit.State> states) => Saves++;
    }
}
