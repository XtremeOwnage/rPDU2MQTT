using rPDU2MQTT.Abstractions.Flow;
using rPDU2MQTT.Abstractions.Pipeline;
using rPDU2MQTT.Grains.Abstractions.Flow;

namespace rPDU2MQTT.Hosting;

/// <summary>
/// The write side of the flow middleware for in-process sources (v3): forwards measurement snapshots to the
/// FlowGrain. A process-bound source (the MQTT subscription manager) emits into this on each event, so the
/// grain is fed event-driven with no polling bridge. Implements the pipeline's <see cref="ISnapshotSink{T}"/>
/// so the source depends only on the contract, not on Orleans.
/// </summary>
public sealed class FlowGrainSink : ISnapshotSink<MeasurementSnapshot>
{
    private readonly Orleans.IGrainFactory grains;

    public FlowGrainSink(Orleans.IGrainFactory grains) => this.grains = grains;

    public async ValueTask EmitAsync(MeasurementSnapshot snapshot, CancellationToken cancellationToken = default)
        => await grains.GetGrain<IFlowGrain>(0).Ingest(snapshot);
}
