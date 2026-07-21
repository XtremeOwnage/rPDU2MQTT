using rPDU2MQTT.Abstractions.Pdu;
using rPDU2MQTT.Core.Transport;

namespace rPDU2MQTT.Grains.Abstractions.Pdu;

/// <summary>
/// One PDU outlet as its own grain (key <c>deviceId|index</c>) — the actor for a single outlet. It holds the
/// outlet's observed state (fed by its parent <see cref="IPduGrain"/> on each poll) and is the single
/// cluster-wide owner of <b>writes</b> to that outlet, so a control action executes exactly once no matter how
/// many processes received the command. This is the read+write leaf of the PDU → outlets grain tree.
/// </summary>
public interface IOutletGrain : IGrainWithStringKey
{
    /// <summary>
    /// Take this outlet's document from the latest poll, handed down by its device grain. The outlet
    /// extracts its own state and its own measurements from it — the parent doesn't pick fields on its
    /// behalf. <paramref name="instanceId"/> is the PDU it lives on, which is what routes its writes.
    /// </summary>
    Task Observe(RawOutlet outlet, string deviceId, string instanceId, DateTime atUtc);

    /// <summary>The outlet's last observed state, or null if not polled yet.</summary>
    Task<OutletState?> State();

    /// <summary>The outlet's whole last document — measurements included.</summary>
    Task<RawOutlet?> Document();

    /// <summary>Execute a write against this outlet: <c>on</c>, <c>off</c>, <c>reboot</c>, or <c>resetStats</c>.</summary>
    Task<string> Control(string action);

    /// <summary>
    /// Write one outlet config field (delay as an integer when <paramref name="isDelay"/>, else the raw
    /// string). Returns the applied value (empty on a bad value) so the caller can echo it back.
    /// </summary>
    Task<string> SetConfig(string field, string payload, bool isDelay);

    /// <summary>The grain key for an outlet on a device.</summary>
    static string KeyFor(string deviceId, int outletIndex) => $"{deviceId}|{outletIndex}";
}
