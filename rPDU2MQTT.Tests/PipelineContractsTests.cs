using rPDU2MQTT.Abstractions.Flow;
using rPDU2MQTT.Abstractions.Pipeline;
using rPDU2MQTT.Core.Pipeline;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// The v3 pipeline contracts (docs/v3-orleans-migration.md). The point of these is the *litmus*: a source,
/// the flow middleware, and a destination wire together end-to-end using nothing but the abstractions and
/// in-memory fakes — no Orleans, no MQTT, no Modbus. If this needs a framework to run, the layering leaked.
/// </summary>
public class PipelineContractsTests
{
    // --- fakes (pure; implement only the contracts) ---

    private sealed class FakeSource : ISourceHost<MeasurementSnapshot>
    {
        private readonly MeasurementSnapshot[] toEmit;
        public FakeSource(string id, params MeasurementSnapshot[] toEmit) { Id = id; this.toEmit = toEmit; }
        public string Id { get; }
        public string Description => "fake";
        public async Task RunAsync(ISnapshotSink<MeasurementSnapshot> sink, CancellationToken ct)
        {
            foreach (var s in toEmit) await sink.EmitAsync(s, ct);
        }
    }

    /// <summary>Trivial middleware: last-value-wins per (node, metric), echoed straight out as a FlowSnapshot.</summary>
    private sealed class PassthroughMiddleware : IFlowMiddleware
    {
        private readonly Dictionary<(string, Metric), double> state = new();
        private readonly Dictionary<string, long> srcVersions = new();
        private long version;
        public void Ingest(MeasurementSnapshot m)
        {
            if (srcVersions.TryGetValue(m.SourceId, out var seen) && m.Version <= seen) return; // order-tolerant
            srcVersions[m.SourceId] = m.Version;
            foreach (var r in m.Readings) state[(r.NodeId, r.Metric)] = r.Value;
        }
        public FlowSnapshot Snapshot() => new(
            FlowSnapshot.FlowSourceId, DateTimeOffset.UtcNow, ++version,
            state.Select(kv => new FlowNodeValue(kv.Key.Item1, kv.Key.Item2, kv.Value)).ToList());
        public IReadOnlyList<RawValue> RawValues() =>
            state.Select(kv => new RawValue(kv.Key.Item1, kv.Key.Item2, kv.Value)).ToList();
    }

    private sealed class FakeDestination : IDestination<FlowSnapshot>
    {
        public FlowSnapshot? Last { get; private set; }
        public string Id => "fake-dest";
        public ValueTask PushAsync(FlowSnapshot s, CancellationToken ct = default) { Last = s; return ValueTask.CompletedTask; }
    }

    private static MeasurementSnapshot Meas(string src, long ver, params (string node, Metric m, double v)[] r)
        => new(src, DateTimeOffset.UtcNow, ver, r.Select(x => new MeasurementReading(x.node, x.m, x.v, 900)).ToList());

    private static async Task<bool> MoveNextWithin<T>(IAsyncEnumerator<T> e, int ms)
    {
        var next = e.MoveNextAsync().AsTask();
        return await Task.WhenAny(next, Task.Delay(ms)) == next && next.Result;
    }

    // --- the litmus: source -> stream -> middleware -> destination, all fakes ---

    [Fact]
    public async Task Pipeline_Flows_SourceToMiddlewareToDestination_WithFakesOnly()
    {
        var stream = new ChannelSnapshotStream<MeasurementSnapshot>();
        var middleware = new PassthroughMiddleware();
        var destination = new FakeDestination();
        var source = new FakeSource("modbus:eg4", Meas("modbus:eg4", 1, ("grid", Metric.RealPower, 1200), ("solar", Metric.RealPower, 800)));

        await using var sub = stream.Subscribe().GetAsyncEnumerator();
        await source.RunAsync(stream, CancellationToken.None);      // producer emits into the sink

        Assert.True(await MoveNextWithin(sub, 1000));               // consumer receives from the feed
        middleware.Ingest(sub.Current);                             // middleware maps it
        await destination.PushAsync(middleware.Snapshot());         // destination consumes the flow output

        Assert.NotNull(destination.Last);
        Assert.Equal(1200, destination.Last!.Values.Single(v => v.NodeId == "grid" && v.Metric == Metric.RealPower).Value);
        Assert.Equal(800, destination.Last!.Values.Single(v => v.NodeId == "solar" && v.Metric == Metric.RealPower).Value);
    }

    [Fact]
    public async Task Stream_FansOut_ToEverySubscriberIndependently()
    {
        var stream = new ChannelSnapshotStream<MeasurementSnapshot>();
        await using var a = stream.Subscribe().GetAsyncEnumerator();
        await using var b = stream.Subscribe().GetAsyncEnumerator();

        await stream.EmitAsync(Meas("s", 1, ("n", Metric.Energy, 42)));

        Assert.True(await MoveNextWithin(a, 1000));
        Assert.True(await MoveNextWithin(b, 1000));
        Assert.Equal(42, a.Current.Readings[0].Value);
        Assert.Equal(42, b.Current.Readings[0].Value);
    }

    [Fact]
    public async Task Stream_SlowConsumer_DropsOldest_NeverBlocksProducer()
    {
        var stream = new ChannelSnapshotStream<MeasurementSnapshot>();
        await using var slow = stream.Subscribe(capacity: 2).GetAsyncEnumerator();

        for (long v = 1; v <= 5; v++)
        {
            var emit = stream.EmitAsync(Meas("s", v, ("n", Metric.RealPower, v)));
            Assert.True(emit.IsCompleted);   // producer is never stalled by a lagging consumer
        }

        // Capacity 2 + DropOldest ⇒ only the newest two survived.
        Assert.True(await MoveNextWithin(slow, 1000)); var first = slow.Current.Version;
        Assert.True(await MoveNextWithin(slow, 1000)); var second = slow.Current.Version;
        Assert.Equal(4, first);
        Assert.Equal(5, second);
    }

    // --- cache: current-state shield + version dedup ---

    [Fact]
    public void Cache_KeepsLatest_AndRejectsStaleOrDuplicate()
    {
        var cache = new VersionedSnapshotCache<MeasurementSnapshot>();

        Assert.True(cache.Accept(Meas("dev", 5)));
        Assert.False(cache.Accept(Meas("dev", 5)));   // duplicate version
        Assert.False(cache.Accept(Meas("dev", 3)));   // out-of-order (older)
        Assert.True(cache.Accept(Meas("dev", 6)));    // newer wins

        Assert.Equal(6, cache.Latest("dev")!.Version);
        Assert.Null(cache.Latest("other"));
    }

    [Fact]
    public void Metric_RoundTripsCanonicalNames()
    {
        foreach (Metric m in Enum.GetValues<Metric>())
        {
            Assert.True(Metrics.TryParse(m.CanonicalName(), out var parsed));
            Assert.Equal(m, parsed);
        }
        Assert.False(Metrics.TryParse("bogus", out _));
    }

    /// <summary>
    /// The architectural invariant, executable: the contract layer must reference no framework — no Orleans,
    /// no transport, no config library. If a grain/transport type ever leaks into Abstractions, this fails.
    /// </summary>
    [Fact]
    public void Abstractions_ReferencesNoFramework()
    {
        var referenced = typeof(ISnapshot).Assembly.GetReferencedAssemblies().Select(a => a.Name ?? "").ToList();
        string[] forbidden = { "Orleans", "HiveMQtt", "FluentModbus", "KubernetesClient", "Serilog", "YamlDotNet", "prometheus-net", "Microsoft.AspNetCore" };
        foreach (var f in forbidden)
            Assert.DoesNotContain(referenced, r => r.Contains(f, StringComparison.OrdinalIgnoreCase));
    }
}
