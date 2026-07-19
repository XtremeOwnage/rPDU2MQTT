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
}
