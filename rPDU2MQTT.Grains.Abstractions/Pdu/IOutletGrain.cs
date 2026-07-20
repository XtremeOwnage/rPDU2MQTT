using rPDU2MQTT.Abstractions.Pdu;

namespace rPDU2MQTT.Grains.Abstractions.Pdu;

/// <summary>
/// One PDU outlet as its own grain (key <c>deviceId|index</c>) — the actor for a single outlet. It holds the
/// outlet's observed state (fed by its parent <see cref="IPduGrain"/> on each poll) and is the single
/// cluster-wide owner of <b>writes</b> to that outlet, so a control action executes exactly once no matter how
/// many processes received the command. This is the read+write leaf of the PDU → outlets grain tree.
/// </summary>
public interface IOutletGrain : IGrainWithStringKey
{
    /// <summary>Record the outlet's latest observed state (pushed by the PDU grain's poll fan-out).</summary>
    Task Observe(OutletState state);

    /// <summary>The outlet's last observed state, or null if not polled yet.</summary>
    Task<OutletState?> State();

    /// <summary>Execute a write against this outlet: <c>on</c>, <c>off</c>, <c>reboot</c>, or <c>resetStats</c>.</summary>
    Task<string> Control(string action);

    /// <summary>The grain key for an outlet on a device.</summary>
    static string KeyFor(string deviceId, int outletIndex) => $"{deviceId}|{outletIndex}";
}
