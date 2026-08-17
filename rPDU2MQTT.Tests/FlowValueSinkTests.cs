using rPDU2MQTT.Abstractions.Flow;
using rPDU2MQTT.Core.Flow;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// The ordering rule for measurement snapshots.
///
/// <para>
/// The rule and the assertions are the ones this has always had — it is the rule
/// that matters, not where it runs — so they were retargeted rather than deleted.
/// </para>
/// </summary>
public class FlowValueSinkTests
{
    private static MeasurementSnapshot Snapshot(string source, DateTimeOffset at, long version, double value)
        => new(source, at, version, [new MeasurementReading("n", Metric.RealPower, value, 900)]);

    [Fact]
    public async Task AnOlderSnapshotFromOneSourceIsIgnored()
    {
        var cache = new FlowValueCache();
        var sink = new FlowValueSink(cache);
        var t = DateTimeOffset.UtcNow;

        await sink.EmitAsync(Snapshot("s", t, 5, 500));
        // Out of order within one source: a lower version created earlier is not news.
        await sink.EmitAsync(Snapshot("s", t.AddSeconds(-1), 3, 999));

        Assert.True(cache.TryGetValue("n", Metric.RealPower.CanonicalName(), out var v));
        Assert.Equal(500, v);
    }

    [Fact]
    public async Task ASourceThatRestartedIsNotLockedOut()
    {
        // A source process restarts: its version counter drops back to a low number while wall-clock time
        // has moved on. Rejecting that is the bug that silently froze MQTT after a rollout while the
        // roll-up kept serving the last value — so a snapshot is stale only when it is behind on BOTH.
        var cache = new FlowValueCache();
        var sink = new FlowValueSink(cache);
        var t = DateTimeOffset.UtcNow;

        await sink.EmitAsync(Snapshot("s", t, 900, 500));
        await sink.EmitAsync(Snapshot("s", t.AddSeconds(30), 1, 750));

        Assert.True(cache.TryGetValue("n", Metric.RealPower.CanonicalName(), out var v));
        Assert.Equal(750, v);
    }

    [Fact]
    public async Task SourcesAreOrderedIndependently()
    {
        // One source's version numbers say nothing about another's; they are separate counters.
        var cache = new FlowValueCache();
        var sink = new FlowValueSink(cache);
        var t = DateTimeOffset.UtcNow;

        await sink.EmitAsync(Snapshot("high", t, 500, 100));
        await sink.EmitAsync(Snapshot("low", t.AddSeconds(1), 1, 250));

        Assert.True(cache.TryGetValue("n", Metric.RealPower.CanonicalName(), out var v));
        Assert.Equal(250, v);
    }
}
