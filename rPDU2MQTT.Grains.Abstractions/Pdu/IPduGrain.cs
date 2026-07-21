using rPDU2MQTT.Abstractions.Pdu;
using rPDU2MQTT.Core.Transport;

namespace rPDU2MQTT.Grains.Abstractions.Pdu;

/// <summary>
/// A PDU instance as a single-activation grain, keyed by the instance id. One owner polls the device
/// cluster-wide (so multiple worker silos share PDU load, each instance polled exactly once) and serves the
/// latest reading to every process — replacing the v2 poller + the MqttBusBridge snapshot mirroring.
/// <para>
/// It serves the <see cref="RawSnapshot"/> wire form, not the live <c>PduData</c>: the PDU models can't be
/// re-serialized faithfully (their Key and computed names are <c>[JsonIgnore]</c>), so this carries the
/// finished fields explicitly — the same contract the bus bridge used cross-process.
/// </para>
/// </summary>
public interface IPduGrain : IGrainWithStringKey
{
    /// <summary>Poll the PDU now if due (throttled to the instance's interval) and hold the result.</summary>
    Task Poll();

    /// <summary>The most recent snapshot for this instance in the round-trippable wire form, or null if none yet.</summary>
    Task<RawSnapshot?> Latest();

    /// <summary>The child grains this PDU supervises (device + outlet grain keys), from its latest poll.</summary>
    Task<PduChildren> Children();

    // --- Writes -------------------------------------------------------------------------------------
    //
    // This grain holds the connection to one physical PDU, so it is also the one thing that talks to it.
    // Its children (outlets, groups) stay the single cluster-wide owners of *their* writes — they serialize
    // per outlet and per group — but they ask their parent to perform the device call rather than going and
    // finding a PDU for themselves. With several PDUs bridged, a child that resolves its own PDU can only
    // guess; asking the parent it was given can't address the wrong device.

    /// <summary>Action an outlet on this PDU: <c>on</c>, <c>off</c>, <c>reboot</c>, or <c>resetStats</c>.</summary>
    Task<string> ControlOutlet(string deviceId, int outletIndex, string action);

    /// <summary>Write one outlet config field on this PDU. Returns the applied value (empty when rejected).</summary>
    Task<string> SetOutletConfig(string deviceId, int outletIndex, string field, string payload, bool isDelay);

    /// <summary>Action a OneView group on this PDU, fanning out to its member outlets.</summary>
    Task<string> ControlGroup(string groupKey, string action);
}
