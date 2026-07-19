using rPDU2MQTT.Core;

namespace rPDU2MQTT.Grains.Abstractions.Pdu;

/// <summary>
/// A PDU instance as a single-activation grain, keyed by the instance id. One owner polls the device
/// cluster-wide (so multiple worker silos share PDU load, each instance polled exactly once), holds the
/// latest <see cref="PduSnapshot"/>, and serves it to every process — replacing the v2 poller + the
/// MqttBusBridge snapshot mirroring.
/// </summary>
public interface IPduGrain : IGrainWithStringKey
{
    /// <summary>Poll the PDU now if due (throttled to the instance's interval) and hold the result.</summary>
    Task Poll();

    /// <summary>The most recent snapshot for this instance, or null if none yet.</summary>
    Task<PduSnapshot?> Latest();
}
