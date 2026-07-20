using Orleans;
using rPDU2MQTT.Abstractions.Pdu;
using rPDU2MQTT.Grains.Abstractions.Pdu;

namespace rPDU2MQTT.Hosting;

/// <summary>
/// Routes outlet writes to the per-outlet <see cref="IOutletGrain"/> (single cluster-wide owner), so a
/// command received on any process actions the outlet exactly once. The Engine-side command subscriber
/// depends only on <see cref="IOutletControl"/>, not on Orleans.
/// </summary>
public sealed class OutletGrainControl : IOutletControl
{
    private readonly IGrainFactory grains;

    public OutletGrainControl(IGrainFactory grains) => this.grains = grains;

    public Task<string> Control(string deviceId, int outletIndex, string action, CancellationToken cancellationToken = default)
        => grains.GetGrain<IOutletGrain>(IOutletGrain.KeyFor(deviceId, outletIndex)).Control(action);

    public Task<string> ControlGroup(string groupKey, string action, CancellationToken cancellationToken = default)
        => grains.GetGrain<IOneViewGroupGrain>(groupKey).Control(action);
}
