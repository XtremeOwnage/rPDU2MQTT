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
