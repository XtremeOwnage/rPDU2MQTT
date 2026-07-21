using rPDU2MQTT.Abstractions.Pdu;
using rPDU2MQTT.Core.Transport;

namespace rPDU2MQTT.Grains.Abstractions.Pdu;

/// <summary>
/// One PDU device as its own grain (key = deviceId) — a child of the PDU supervisor, and the supervisor of
/// its own outlets. Its parent hands it the device's whole document from the poll rather than a
/// pre-extracted summary: the grain decides what it needs from it, pushes each outlet's document down to
/// that outlet's grain, and owns the device-level energy roll-up.
/// </summary>
public interface IPduDeviceGrain : IGrainWithStringKey
{
    /// <summary>
    /// Take this device's document from the latest poll. <paramref name="instanceId"/> is the PDU instance
    /// it came from, so writes anywhere below it route back to the right PDU.
    /// </summary>
    Task Observe(RawDevice device, string instanceId, DateTime atUtc);

    /// <summary>The device's last observed base data, or null if not polled yet.</summary>
    Task<DeviceState?> State();

    /// <summary>The device's whole last document — everything its children were derived from.</summary>
    Task<RawDevice?> Document();
}
