using rPDU2MQTT.Core.Flow;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// Reading the browsable topic index after asking for a filter.
///
/// <para>
/// Asking does not subscribe: the process holding the broker connection polls for the wanted filter on a
/// three-second timer, subscribes, and the retained messages arrive after that. A scan that read the index
/// immediately reported nothing on a broker carrying dozens of matching topics.
/// </para>
/// </summary>
public class TopicIndexScanTests
{
    /// <summary>A fake index that stays empty for the first few polls, then fills and stops changing.</summary>
    private sealed class FakeIndex(int emptyPolls, int finalCount)
    {
        public int Renews;
        public int Searches;
        public TimeSpan Slept;

        public Task Renew() { Renews++; return Task.CompletedTask; }
        public Task Delay(TimeSpan d) { Slept += d; return Task.CompletedTask; }

        public Task<IReadOnlyList<string>> Search()
        {
            Searches++;
            var n = Searches <= emptyPolls ? 0 : Math.Min(finalCount, (Searches - emptyPolls) * finalCount);
            return Task.FromResult<IReadOnlyList<string>>(Enumerable.Range(0, n).Select(i => $"t{i}").ToList());
        }
    }

    private static Task<IReadOnlyList<string>> Run(FakeIndex f, int deadlineSeconds = 12)
    {
        var start = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        var now = start;
        return TopicIndexScan.SettleAsync<string>(
            f.Renew,
            f.Search,
            d => { now = now.Add(d); return f.Delay(d); },
            TimeSpan.FromMilliseconds(750),
            start.AddSeconds(deadlineSeconds),
            () => now);
    }

    [Fact]
    public async Task ItWaitsThroughTheEmptyPollsRatherThanReturningNothing()
    {
        // Two polls before the subscription is live, which is the failure: an immediate read returns [].
        var f = new FakeIndex(emptyPolls: 4, finalCount: 30);

        var found = await Run(f);

        Assert.Equal(30, found.Count);
        Assert.True(f.Searches > 4, "it gave up before the index had filled");
    }

    [Fact]
    public async Task ItStopsAsSoonAsTheCountRepeats()
    {
        // Finishing on settle rather than on a fixed sleep: as soon as the broker has delivered what it has.
        var f = new FakeIndex(emptyPolls: 0, finalCount: 10);

        await Run(f);

        // Poll 1 returns 10, poll 2 returns 10 -> settled. Anything more is waiting for no reason.
        Assert.Equal(2, f.Searches);
        Assert.Equal(TimeSpan.FromMilliseconds(1500), f.Slept);
    }

    [Fact]
    public async Task AnEmptyIndexIsNeverTreatedAsSettled()
    {
        // Zero twice is the state it starts in, not an answer. Accepting it reproduces the original bug.
        var f = new FakeIndex(emptyPolls: int.MaxValue, finalCount: 0);

        var found = await Run(f, deadlineSeconds: 3);

        Assert.Empty(found);
        Assert.True(f.Searches >= 4, $"it stopped after {f.Searches} polls on an empty index");
    }

    [Fact]
    public async Task TheLeaseIsRenewedOnEveryPoll()
    {
        // The lease is short. Waiting a dozen seconds on one renewal would let it lapse mid-scan, and the
        // subscriber would unsubscribe while we were still reading.
        var f = new FakeIndex(emptyPolls: 3, finalCount: 5);

        await Run(f);

        Assert.Equal(f.Searches + 1, f.Renews);   // once up front, then once per poll
    }

    [Fact]
    public async Task ItGivesUpAtTheDeadline()
    {
        var f = new FakeIndex(emptyPolls: int.MaxValue, finalCount: 0);

        await Run(f, deadlineSeconds: 2);

        Assert.InRange(f.Slept.TotalSeconds, 1.5, 3.0);
    }
}
