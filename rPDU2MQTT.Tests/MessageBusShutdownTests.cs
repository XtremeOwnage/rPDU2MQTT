using rPDU2MQTT.Core;
using rPDU2MQTT.Models.PDU;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// Shutting a subscriber down is an ending, not a fault.
///
/// <para>
/// The bus used to enumerate with <c>ReadAllAsync(token)</c>, which throws on cancellation. An iterator
/// cannot catch around a <c>yield return</c>, so the exception escaped into whatever was enumerating —
/// <c>SnapshotCache</c>, a BackgroundService — and the host reported a crashed background service on every
/// clean stop. Nothing failed, which is exactly why it survived: the log said "unhandled exception" while
/// the process was doing precisely what it was told.
/// </para>
/// </summary>
public class MessageBusShutdownTests
{
    private static PduSnapshot Snapshot(string id = "a") => new(id, DateTime.UtcNow, new PduData());

    /// <summary>
    /// Wait for something a background reader does, rather than for a fixed number of milliseconds.
    ///
    /// <para>
    /// These tests hand a snapshot to a channel and then look at what the reader did with it. A fixed
    /// sleep asserts on the scheduler: 80ms is generous on an idle machine and not always enough on a
    /// loaded CI runner, where this failed on <c>Assert.NotNull</c> having passed every local run. Polling
    /// makes the test wait exactly as long as it needs to and fail only when the thing genuinely never
    /// happens.
    /// </para>
    /// </summary>
    private static async Task<bool> Until(Func<bool> done, int timeoutMs = 5000)
    {
        var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (DateTime.UtcNow < deadline)
        {
            if (done()) return true;
            await Task.Delay(5);
        }
        return done();
    }

    [Fact]
    public async Task CancellingASubscription_EndsIt_WithoutThrowing()
    {
        var bus = new ChannelMessageBus();
        using var cts = new CancellationTokenSource();

        // Subscribed on THIS thread, so the channel is registered before anything is published — inside
        // the task it races the publish and the test measures its own scheduling.
        var stream = bus.Subscribe(cancellationToken: cts.Token);

        var received = 0;
        var reader = Task.Run(async () =>
        {
            await foreach (var _ in stream) received++;
        });

        await bus.PublishAsync(Snapshot());
        Assert.True(await Until(() => Volatile.Read(ref received) == 1), "the subscriber never received the published snapshot");
        await cts.CancelAsync();

        // The assertion IS that this completes rather than faulting: an await on a faulted task rethrows.
        await reader;
        Assert.Equal(1, received);
    }

    [Fact]
    public async Task ASnapshotCacheStopsCleanly_RatherThanReportingACrash()
    {
        var bus = new ChannelMessageBus();
        var cache = new SnapshotCache(bus);

        await cache.StartAsync(CancellationToken.None);
        await bus.PublishAsync(Snapshot("pdu-1"));
        Assert.True(await Until(() => cache.Get("pdu-1") is not null), "the cache never took up the published snapshot");

        await cache.StopAsync(CancellationToken.None);

        // BackgroundService surfaces a faulted ExecuteAsync through ExecuteTask; a clean stop leaves it
        // completed. This is the difference the host reports as "a BackgroundService has thrown".
        Assert.True(cache.ExecuteTask is null || !cache.ExecuteTask.IsFaulted);
    }

    [Fact]
    public async Task ASubscriberThatGoesAway_IsForgotten_SoThePublisherDoesNotFeedADeadChannel()
    {
        var bus = new ChannelMessageBus();
        using var cts = new CancellationTokenSource();

        var subscribed = 0;
        var stream = bus.Subscribe(cancellationToken: cts.Token);
        var reader = Task.Run(async () => { Interlocked.Exchange(ref subscribed, 1); await foreach (var _ in stream) { } });

        Assert.True(await Until(() => Volatile.Read(ref subscribed) == 1), "the reader never started");
        await cts.CancelAsync();
        await reader;

        // Publishing after every subscriber has gone must still be safe — the cleanup runs in the finally,
        // which is why that block was there in the first place and had to survive this change.
        await bus.PublishAsync(Snapshot());
    }
}
