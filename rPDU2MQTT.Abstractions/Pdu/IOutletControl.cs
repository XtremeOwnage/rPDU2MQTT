namespace rPDU2MQTT.Abstractions.Pdu;

/// <summary>
/// What a write did. <paramref name="Ok"/> is false when it did not reach the device at all — nothing has
/// polled it, its PDU is not configured, the action is not one this device supports.
/// <para>
/// Separate from the message because every caller has to decide something on it: the GUI reports success,
/// and the MQTT subscriber echoes the new state to Home Assistant. Echoing "off" for a write that never
/// happened is the same fabrication as publishing a reading nobody took.
/// </para>
/// </summary>
public readonly record struct OutletWriteResult(bool Ok, string Message)
{
    public static OutletWriteResult Applied(string message) => new(true, message);
    public static OutletWriteResult Refused(string message) => new(false, message);
}

/// <summary>
/// The write seam for outlet control (framework-free): a command source (the MQTT command subscriber) calls
/// this to action an outlet, and the host routes it to whatever owns that device's writes.
/// </summary>
public interface IOutletControl
{
    /// <summary>Action an outlet: <c>on</c>, <c>off</c>, <c>reboot</c>, or <c>resetStats</c>.</summary>
    Task<OutletWriteResult> Control(string deviceId, int outletIndex, string action, CancellationToken cancellationToken = default);

    /// <summary>Action a OneView group (fans out to its member outlets): <c>on</c>, <c>off</c>, or <c>reboot</c>.</summary>
    Task<OutletWriteResult> ControlGroup(string groupKey, string action, CancellationToken cancellationToken = default);

    /// <summary>Write one outlet config field. Returns the applied value (empty on a bad value) for the echo.</summary>
    Task<string> SetOutletConfig(string deviceId, int outletIndex, string field, string payload, bool isDelay, CancellationToken cancellationToken = default);
}
