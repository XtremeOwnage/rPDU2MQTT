using rPDU2MQTT.Core.Integrations;
using rPDU2MQTT.Models.PDU;

namespace rPDU2MQTT.Plugin.Vertiv;

/// <summary>Reads a configured Vertiv rPDU instance.</summary>
public sealed class VertivDeviceReader : IDeviceReader
{
    private readonly PduInstanceRegistry registry;

    public VertivDeviceReader(PduInstanceRegistry registry) => this.registry = registry;

    public bool Handles(string instanceId, Config cfg) => registry.Enabled && registry.All.ContainsKey(instanceId);

    public async Task<PduData?> ReadAsync(string instanceId, Config cfg, CancellationToken ct)
        => registry.All.TryGetValue(instanceId, out var pdu) ? await pdu.ReadAsync(ct) : null;

    public TimeSpan Interval(string instanceId, Config cfg)
        => TimeSpan.FromSeconds(Math.Max(1, cfg.Pdus.TryGetValue(instanceId, out var c) ? c.PollInterval : 5));
}
