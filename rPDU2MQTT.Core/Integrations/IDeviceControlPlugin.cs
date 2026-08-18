using rPDU2MQTT.Classes;

namespace rPDU2MQTT.Core.Integrations;

/// <summary>
/// A device plugin whose outlets can be switched, not just read.
///
/// <para>
/// Separate from <see cref="IDeviceSourcePlugin"/> because plenty of hardware is read-only — a meter, a CT
/// clamp, an inverter — and a device that cannot switch anything should not have to implement a method
/// that throws. Reading and writing also fail differently: a failed read ages a value out, while a failed
/// write leaves an operator not knowing whether the outlet moved.
/// </para>
/// <para>
/// The host routes a command here from wherever it arrived — the MQTT command topic, the GUI's control
/// page, the API — and holds the single-owner lease while it runs, so two processes cannot action the
/// same outlet at once. A plugin implements what its hardware does and nothing about how the request
/// reached it.
/// </para>
/// </summary>
public interface IDeviceControlPlugin
{
    /// <summary>
    /// Action one outlet. <paramref name="action"/> is <c>on</c>, <c>off</c>, <c>reboot</c> or
    /// <c>resetStats</c>; return what happened, for the log and the command echo.
    /// </summary>
    /// <remarks>
    /// Report what the device confirmed, not what was asked of it. A plugin that returns "on" for a command
    /// the hardware rejected produces an echo that contradicts the next poll, and the operator sees an
    /// outlet flip back a few seconds later with no explanation.
    /// </remarks>
    Task<string> ControlOutletAsync(Config cfg, string deviceId, int outletIndex, string action, CancellationToken ct);

    /// <summary>
    /// Whether this action is supported at all. A device with no reboot returns false rather than failing
    /// the command, so the GUI can decline to offer it instead of showing a button that never works.
    /// </summary>
    bool Supports(string action) => action is "on" or "off";
}
