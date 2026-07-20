using rPDU2MQTT.Abstractions.Flow;
using rPDU2MQTT.Grains.Abstractions.Flow;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// The flow middleware as a grain: measurements ingested from a (simulated) source are served back through
/// the grain — which also exercises shipping the framework-free pipeline DTOs across the grain boundary via
/// the JSON serializer (they carry no Orleans attributes by design).
/// </summary>
public class FlowGrainTests
{
    [Fact]
    public async Task FlowGrain_Ingests_AndServesNodeValue()
    {
        var cluster = await GrainTestCluster.StartAsync();
        try
        {
            var flow = cluster.GrainFactory.GetGrain<IFlowGrain>(0);
            await flow.Ingest(new MeasurementSnapshot("modbus:eg4", DateTimeOffset.UtcNow, 1,
                new[] { new MeasurementReading("grid", Metric.RealPower, 1200, 900) }));

            Assert.Equal(1200, await flow.NodeValue("grid", Metric.RealPower));
            Assert.Null(await flow.NodeValue("grid", Metric.Energy));    // nothing ingested for this metric

            // RawValues drives the per-process sync back into each IFlowValueSource.
            var raw = await flow.RawValues();
            Assert.Contains(raw, r => r.NodeId == "grid" && r.Metric == Metric.RealPower && r.Value == 1200);
        }
        finally { await cluster.StopAllSilosAsync(); }
    }

    [Fact]
    public async Task FlowGrain_IgnoresStaleVersions()
    {
        var cluster = await GrainTestCluster.StartAsync();
        try
        {
            var flow = cluster.GrainFactory.GetGrain<IFlowGrain>(0);
            await flow.Ingest(new MeasurementSnapshot("s", DateTimeOffset.UtcNow, 5, new[] { new MeasurementReading("n", Metric.RealPower, 500, 900) }));
            await flow.Ingest(new MeasurementSnapshot("s", DateTimeOffset.UtcNow, 3, new[] { new MeasurementReading("n", Metric.RealPower, 999, 900) })); // older, ignored

            Assert.Equal(500, await flow.NodeValue("n", Metric.RealPower));
        }
        finally { await cluster.StopAllSilosAsync(); }
    }
}

/// <summary>
/// The polymorphic node-grain tree: measured leaves hold a source's value, aggregate nodes sum their
/// children, and the roll-up is distributed grain-to-grain — the model for a densely-measured tree
/// (panels → strings → MPPTs → sub-panels → total).
/// </summary>
public class NodeGrainTests
{
    [Fact]
    public async Task Ingest_FeedsMeasuredLeafGrains()
    {
        var cluster = await GrainTestCluster.StartAsync();
        try
        {
            await cluster.GrainFactory.GetGrain<IFlowGrain>(0).Ingest(new MeasurementSnapshot(
                "modbus:tigo", DateTimeOffset.UtcNow, 1, new[]
                {
                    new MeasurementReading("panel-1", Metric.RealPower, 300, 900),
                    new MeasurementReading("panel-2", Metric.RealPower, 250, 900),
                }));

            Assert.Equal(300, await cluster.GrainFactory.GetGrain<IMeasuredNodeGrain>("panel-1").Value(Metric.RealPower));
            Assert.Equal(250, await cluster.GrainFactory.GetGrain<IMeasuredNodeGrain>("panel-2").Value(Metric.RealPower));
            Assert.Null(await cluster.GrainFactory.GetGrain<IMeasuredNodeGrain>("panel-3").Value(Metric.RealPower));
        }
        finally { await cluster.StopAllSilosAsync(); }
    }

    [Fact]
    public async Task Aggregate_RollsUp_Children_Distributed()
    {
        var cluster = await GrainTestCluster.StartAsync();
        try
        {
            var f = cluster.GrainFactory;
            // Measured leaves: individual panels.
            await f.GetGrain<IMeasuredNodeGrain>("panel-1").Observe(Metric.RealPower, 300);
            await f.GetGrain<IMeasuredNodeGrain>("panel-2").Observe(Metric.RealPower, 250);
            await f.GetGrain<IMeasuredNodeGrain>("panel-3").Observe(Metric.RealPower, 275);

            // A string sums two panels; the MPPT sums the string plus a third panel — a two-level roll-up.
            await f.GetGrain<IAggregateNodeGrain>("string-1").Configure(new NodeSpec("aggregate",
                new() { new("measured", "panel-1"), new("measured", "panel-2") }));
            await f.GetGrain<IAggregateNodeGrain>("mppt-1").Configure(new NodeSpec("aggregate",
                new() { new("aggregate", "string-1"), new("measured", "panel-3") }));

            Assert.Equal(550, await f.GetGrain<IAggregateNodeGrain>("string-1").Value(Metric.RealPower));
            Assert.Equal(825, await f.GetGrain<IAggregateNodeGrain>("mppt-1").Value(Metric.RealPower));

            // An unconfigured aggregate has no children → no value.
            Assert.Null(await f.GetGrain<IAggregateNodeGrain>("empty").Value(Metric.RealPower));
        }
        finally { await cluster.StopAllSilosAsync(); }
    }
}
