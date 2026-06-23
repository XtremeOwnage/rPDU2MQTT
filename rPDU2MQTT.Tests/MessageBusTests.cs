using rPDU2MQTT.Core;
using rPDU2MQTT.Models.PDU;
using Xunit;

namespace rPDU2MQTT.Tests;

public class MessageBusTests
{
    private static PduSnapshot Snap(string id) => new(id, DateTime.UtcNow, new PduData());

    [Fact]
    public async Task Subscriber_ReceivesPublishedSnapshots()
    {
        var bus = new ChannelMessageBus();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var enumerator = bus.Subscribe(cancellationToken: cts.Token).GetAsyncEnumerator(cts.Token);

        await bus.PublishAsync(Snap("pdu-1"));

        Assert.True(await enumerator.MoveNextAsync());
        Assert.Equal("pdu-1", enumerator.Current.InstanceId);

        await enumerator.DisposeAsync();
    }

    [Fact]
    public async Task EverySubscriber_GetsEverySnapshot()
    {
        var bus = new ChannelMessageBus();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var a = bus.Subscribe(cancellationToken: cts.Token).GetAsyncEnumerator(cts.Token);
        var b = bus.Subscribe(cancellationToken: cts.Token).GetAsyncEnumerator(cts.Token);

        await bus.PublishAsync(Snap("pdu-1"));

        Assert.True(await a.MoveNextAsync());
        Assert.True(await b.MoveNextAsync());
        Assert.Equal("pdu-1", a.Current.InstanceId);
        Assert.Equal("pdu-1", b.Current.InstanceId);

        await a.DisposeAsync();
        await b.DisposeAsync();
    }

    [Fact]
    public async Task Publish_WithNoSubscribers_DoesNotThrow()
    {
        var bus = new ChannelMessageBus();
        await bus.PublishAsync(Snap("pdu-1"));
    }

    [Fact]
    public async Task SlowSubscriber_DropsOldest_WithoutBlockingPublish()
    {
        var bus = new ChannelMessageBus();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        // Capacity 2, never read until after we over-publish: oldest snapshots are dropped, not blocked.
        var enumerator = bus.Subscribe(capacity: 2, cancellationToken: cts.Token).GetAsyncEnumerator(cts.Token);

        for (var i = 0; i < 5; i++)
            await bus.PublishAsync(Snap($"pdu-{i}"));

        Assert.True(await enumerator.MoveNextAsync());
        var first = enumerator.Current.InstanceId;
        Assert.True(await enumerator.MoveNextAsync());
        var second = enumerator.Current.InstanceId;

        // Only the two most-recent survived the bounded DropOldest buffer.
        Assert.Equal(new[] { "pdu-3", "pdu-4" }, new[] { first, second });

        await enumerator.DisposeAsync();
    }
}
