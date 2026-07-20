using rPDU2MQTT.Abstractions.Pdu;
using rPDU2MQTT.Grains.Abstractions.Pdu;

namespace rPDU2MQTT.Grains.Pdu;

/// <summary>One PDU device's base data (key = deviceId). A read child of the PDU supervisor grain.</summary>
public sealed class PduDeviceGrain : Grain, IPduDeviceGrain
{
    private DeviceState? state;

    public Task Observe(DeviceState s) { state = s; return Task.CompletedTask; }

    public Task<DeviceState?> State() => Task.FromResult(state);
}
