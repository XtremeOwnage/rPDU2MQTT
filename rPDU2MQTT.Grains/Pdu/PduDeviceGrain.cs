using rPDU2MQTT.Abstractions.Flow;
using rPDU2MQTT.Abstractions.Pdu;
using rPDU2MQTT.Core.Transport;
using rPDU2MQTT.Grains.Abstractions.Flow;
using rPDU2MQTT.Grains.Abstractions.Pdu;

namespace rPDU2MQTT.Grains.Pdu;

/// <summary>
/// One PDU device (key = deviceId): a child of the PDU supervisor, and the supervisor of its own outlets.
/// <para>
/// The PDU grain hands it the device's whole document and nothing else — this grain extracts its own base
/// data from it, hands each outlet's document to that outlet's grain, and owns the device's energy roll-up
/// node (<c>pdu:{deviceId}</c> summing its outlets). Extraction belongs to whoever needs the fields.
/// </para>
/// </summary>
public sealed class PduDeviceGrain : Grain, IPduDeviceGrain
{
    private RawDevice? document;
    private DeviceState? state;

    public async Task Observe(RawDevice device, string instanceId, DateTime atUtc)
    {
        var deviceId = this.GetPrimaryKeyString();
        document = device;
        state = new DeviceState(deviceId, device.Name, device.DisplayName, device.Make, device.Model, device.State, atUtc, instanceId);

        // Hand each outlet its own document; it extracts its state and its measurements itself.
        var outletNodes = new List<NodeChild>();
        foreach (var outlet in device.Outlets)
        {
            await GrainFactory.GetGrain<IOutletGrain>(IOutletGrain.KeyFor(deviceId, outlet.Key))
                .Observe(outlet, deviceId, instanceId, atUtc);
            outletNodes.Add(new NodeChild("measured", OutletGrain.FlowNodeId(deviceId, outlet.Key)));
        }

        // The device's own tier of the energy flow: an aggregate node summing the outlets beneath it. Ids
        // follow the auto convention (pdu:/outlet:) so a custom node can wire onto them.
        await GrainFactory.GetGrain<IAggregateNodeGrain>($"pdu:{deviceId}")
            .Configure(new NodeSpec("aggregate", outletNodes));
    }

    public Task<DeviceState?> State() => Task.FromResult(state);

    public Task<RawDevice?> Document() => Task.FromResult(document);
}
