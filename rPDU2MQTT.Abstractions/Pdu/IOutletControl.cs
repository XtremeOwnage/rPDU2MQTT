namespace rPDU2MQTT.Abstractions.Pdu;

/// <summary>
/// The write seam for outlet control (framework-free): a command source (the MQTT command subscriber) calls
/// this to action an outlet, and the host routes it to whatever owns that device's writes.
/// </summary>
public interface IOutletControl
{
    /// <summary>Action an outlet: <c>on</c>, <c>off</c>, <c>reboot</c>, or <c>resetStats</c>.</summary>
    Task<string> Control(string deviceId, int outletIndex, string action, CancellationToken cancellationToken = default);

    /// <summary>Action a OneView group (fans out to its member outlets): <c>on</c>, <c>off</c>, or <c>reboot</c>.</summary>
    Task<string> ControlGroup(string groupKey, string action, CancellationToken cancellationToken = default);

    /// <summary>Write one outlet config field. Returns the applied value (empty on a bad value) for the echo.</summary>
    Task<string> SetOutletConfig(string deviceId, int outletIndex, string field, string payload, bool isDelay, CancellationToken cancellationToken = default);
}
