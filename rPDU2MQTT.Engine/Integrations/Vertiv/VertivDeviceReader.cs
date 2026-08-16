using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Integrations;
using rPDU2MQTT.Models.PDU;

namespace rPDU2MQTT.Integrations.Vertiv;

/// <summary>
/// Reads a configured Vertiv rPDU — the built-in reader, and now one implementation among others rather
/// than the hardcoded call inside the supervising grain.
/// </summary>
public sealed class VertivDeviceReader : IDeviceReader
{
    private readonly PduInstanceRegistry registry;

    public VertivDeviceReader(PduInstanceRegistry registry) => this.registry = registry;

    public bool Handles(string instanceId, Config cfg) => registry.All.ContainsKey(instanceId);

    public async Task<PduData?> ReadAsync(string instanceId, Config cfg, CancellationToken ct)
        // Awaited rather than returned, so the nullable contract is satisfied honestly instead of by a
        // null-forgiving cast on a Task the compiler was right to object to.
        => registry.All.TryGetValue(instanceId, out var pdu) ? await pdu.GetRootData_Public(ct) : null;

    public TimeSpan Interval(string instanceId, Config cfg)
        => TimeSpan.FromSeconds(Math.Max(1, cfg.Pdus.TryGetValue(instanceId, out var c) ? c.PollInterval : 5));
}
