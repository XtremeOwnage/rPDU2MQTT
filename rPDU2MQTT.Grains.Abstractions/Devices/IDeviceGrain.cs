using rPDU2MQTT.Abstractions.Flow;

namespace rPDU2MQTT.Grains.Abstractions.Devices;

/// <summary>
/// A Modbus device as a single-activation grain, keyed by the Modbus connection id. Because there is exactly
/// one activation cluster-wide and grains are single-threaded, this is the one owner of the device
/// connection — the structural fix for a single-client RS485 gateway. Any number of silos may call
/// <see cref="Poll"/>; the calls route to the one activation and serialize, and the grain throttles to the
/// connection's poll interval, so the device is read once per interval no matter how many callers there are.
/// </summary>
public interface IDeviceGrain : IGrainWithStringKey
{
    /// <summary>
    /// Read the device now if due (throttled to the configured interval) and push the readings to the flow
    /// grain. Safe to call from anywhere and often — it dedupes by single-activation + throttle.
    /// </summary>
    Task Poll();

    /// <summary>The most recent successful reading set from this device, or null if none yet.</summary>
    Task<MeasurementSnapshot?> Latest();
}
