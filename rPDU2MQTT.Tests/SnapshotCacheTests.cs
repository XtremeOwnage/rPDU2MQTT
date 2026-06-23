using rPDU2MQTT.Core;
using rPDU2MQTT.Models.PDU;
using Xunit;

namespace rPDU2MQTT.Tests;

public class SnapshotCacheTests
{
    private static PduSnapshot Snap(string id) => new(id, DateTime.UtcNow, new PduData());

    private static async Task WaitUntil(Func<bool> condition, TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            if (condition()) return;
            await Task.Delay(20);
        }
        Assert.Fail("Condition not met within timeout.");
    }

    [Fact]
    public async Task Cache_TracksLatestAndPerInstance()
    {
        var bus = new ChannelMessageBus();
        var cache = new SnapshotCache(bus);
        await cache.StartAsync(CancellationToken.None);
        try
        {
            await bus.PublishAsync(Snap("a"));
            await bus.PublishAsync(Snap("b"));

            await WaitUntil(() => cache.Get("a") is not null && cache.Get("b") is not null, TimeSpan.FromSeconds(2));

            Assert.NotNull(cache.Get("a"));
            Assert.NotNull(cache.Get("b"));
            Assert.Equal("b", cache.Latest!.InstanceId);
            Assert.Equal(2, cache.All.Count);
        }
        finally
        {
            await cache.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task Cache_KeepsMostRecentPerInstance()
    {
        var bus = new ChannelMessageBus();
        var cache = new SnapshotCache(bus);
        await cache.StartAsync(CancellationToken.None);
        try
        {
            var first = Snap("a");
            await bus.PublishAsync(first);
            await WaitUntil(() => cache.Get("a") is not null, TimeSpan.FromSeconds(2));

            var second = Snap("a");
            await bus.PublishAsync(second);
            await WaitUntil(() => ReferenceEquals(cache.Get("a"), second), TimeSpan.FromSeconds(2));

            Assert.Single(cache.All);
            Assert.Same(second, cache.Get("a"));
        }
        finally
        {
            await cache.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public void Cache_StartsEmpty()
    {
        var cache = new SnapshotCache(new ChannelMessageBus());
        Assert.Null(cache.Latest);
        Assert.Empty(cache.All);
    }
}

public class SnapshotFreshnessTests
{
    private static readonly DateTime Now = new(2026, 6, 23, 12, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void FreshSnapshot_IsNotStale()
        => Assert.False(SnapshotFreshness.IsStale(Now.AddSeconds(-5), pollIntervalSeconds: 5, Now));

    [Fact]
    public void OldSnapshot_IsStale()
        => Assert.True(SnapshotFreshness.IsStale(Now.AddSeconds(-60), pollIntervalSeconds: 5, Now));

    [Fact]
    public void ShortInterval_HasA30sFloor()
    {
        // 1s poll -> 2.5s would be too twitchy; the 30s floor keeps it tolerant.
        Assert.False(SnapshotFreshness.IsStale(Now.AddSeconds(-20), pollIntervalSeconds: 1, Now));
        Assert.True(SnapshotFreshness.IsStale(Now.AddSeconds(-31), pollIntervalSeconds: 1, Now));
    }
}
