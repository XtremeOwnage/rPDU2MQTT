using rPDU2MQTT.Abstractions.Pdu;

namespace rPDU2MQTT.Grains.Abstractions.Pdu;

/// <summary>One PDU device's base data as its own grain (key = deviceId) — a child of the PDU supervisor.</summary>
public interface IPduDeviceGrain : IGrainWithStringKey
{
    /// <summary>Record the device's latest base data (pushed by the PDU grain's poll fan-out).</summary>
    Task Observe(DeviceState state);

    /// <summary>The device's last observed base data, or null if not polled yet.</summary>
    Task<DeviceState?> State();
}
