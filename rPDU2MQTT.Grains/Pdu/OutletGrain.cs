using rPDU2MQTT.Abstractions.Flow;
using rPDU2MQTT.Abstractions.Pdu;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Core.Transport;
using rPDU2MQTT.Grains.Abstractions.Flow;
using rPDU2MQTT.Grains.Abstractions.Pdu;

namespace rPDU2MQTT.Grains.Pdu;

/// <summary>
/// One PDU outlet (key <c>deviceId|index</c>) — the read+write leaf of the PDU → device → outlet tree.
/// <para>
/// Its device grain hands it its own document each poll; the outlet extracts what it needs from it: its
/// observed state, and its measurements, which it converts to canonical units and publishes to its measured
/// flow node. It is also the single cluster-wide owner of writes to the outlet, so a control action runs
/// exactly once — through the PDU instance the outlet actually lives on (see <see cref="PduChildGrain"/>).
/// </para>
/// </summary>
public sealed class OutletGrain : PduChildGrain, IOutletGrain
{
    private RawOutlet? document;
    private OutletState? state;
    private string deviceId = "";
    private int index;

    /// <summary>The energy-flow node id for an outlet — the auto convention custom nodes can wire onto.</summary>
    public static string FlowNodeId(string deviceId, int index) => $"outlet:{deviceId}:{index}";

    public override Task OnActivateAsync(CancellationToken cancellationToken)
    {
        var key = this.GetPrimaryKeyString();
        var sep = key.LastIndexOf('|');   // deviceId may itself contain '|'; the index is after the last one
        if (sep > 0) { deviceId = key[..sep]; int.TryParse(key[(sep + 1)..], out index); }
        return base.OnActivateAsync(cancellationToken);
    }

    public async Task Observe(RawOutlet outlet, string device, string instanceId, DateTime atUtc)
    {
        deviceId = device;
        index = outlet.Key;
        document = outlet;
        BindOwner(instanceId);
        state = new OutletState(device, outlet.Key, outlet.Name, outlet.DisplayName, outlet.State, atUtc, instanceId);

        // This outlet's measurements are its own: it decides which ones are metrics, converts them to the
        // canonical unit, and feeds its measured flow node — the leaf the whole roll-up is built from.
        var node = GrainFactory.GetGrain<IMeasuredNodeGrain>(FlowNodeId(device, outlet.Key));
        foreach (var m in outlet.Measurements)
            if (m.Type is { } type && Metrics.TryParse(type, out var metric)
                && double.TryParse(m.Value, System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out var value))
                await node.Observe(metric, value * FlowUnits.ToCanonicalFactor(type, m.Units));
    }

    public Task<OutletState?> State() => Task.FromResult(state);

    public Task<RawOutlet?> Document() => Task.FromResult(document);

    /// <summary>
    /// The write. This grain owns the right to make it (single activation ⇒ exactly once, and serialized
    /// per outlet); the PDU it belongs to makes the device call.
    /// </summary>
    public async Task<string> Control(string action)
    {
        if (Parent is not { } pdu) return "No PDU available to control this outlet.";
        return await pdu.ControlOutlet(deviceId, index, action);
    }

    public async Task<string> SetConfig(string field, string payload, bool isDelay)
    {
        if (Parent is not { } pdu) return "";
        return await pdu.SetOutletConfig(deviceId, index, field, payload, isDelay);
    }
}
