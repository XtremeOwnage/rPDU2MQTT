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
        await Task.Delay(80);
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
        await Task.Delay(80);
        Assert.NotNull(cache.Get("pdu-1"));

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

        var stream = bus.Subscribe(cancellationToken: cts.Token);
        var reader = Task.Run(async () => { await foreach (var _ in stream) { } });

        await Task.Delay(50);
        await cts.CancelAsync();
        await reader;

        // Publishing after every subscriber has gone must still be safe — the cleanup runs in the finally,
        // which is why that block was there in the first place and had to survive this change.
        await bus.PublishAsync(Snapshot());
    }
}
