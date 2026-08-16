using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Integrations;

namespace rPDU2MQTT.Hosting;

/// <summary>
/// The configured Modbus devices, offered as things a node could be bound to.
///
/// <para>
/// Deliberately does <b>not</b> scan registers. <see cref="INodeProvider.DiscoverAsync"/> is documented as
/// cheap and interactive because it backs a picker someone is typing into, and a register scan is a real
/// round-trip to a device — on a shared RS485 gateway, several of them at once is how reads start timing
/// out, which is the same constraint that gave devices a single-owner lease in the first place. Firing one
/// per keystroke across every configured device would be the worst possible use of it.
/// </para>
/// <para>
/// So it answers the honest version of the question: here are the devices I can reach, and what to set to
/// bind one. The deep browse stays where it belongs — the register explorer, opened deliberately against
/// one device, which already exists.
/// </para>
/// </summary>
public sealed class ModbusNodeProvider : INodeProvider
{
    public Task<IReadOnlyList<DiscoveredNode>> DiscoverAsync(Config cfg, string? search, CancellationToken ct)
    {
        var found = (cfg.Modbus?.Connections ?? [])
            .Where(c => !string.IsNullOrWhiteSpace(c.Id))
            .Where(c => string.IsNullOrWhiteSpace(search)
                        || c.Id.Contains(search!, StringComparison.OrdinalIgnoreCase)
                        || (c.Name ?? "").Contains(search!, StringComparison.OrdinalIgnoreCase)
                        || c.Host.Contains(search!, StringComparison.OrdinalIgnoreCase))
            .Select(c => new DiscoveredNode(
                Key: c.Id,
                Label: string.IsNullOrWhiteSpace(c.Name) ? $"{c.Host}:{c.Port} unit {c.UnitId}" : c.Name!,
                // Which register, and therefore what it measures, is the one thing only the operator knows.
                // Offering a guess here would be inventing a binding, not discovering one.
                Metric: null,
                Unit: null,
                Sample: null,
                Kind: null,
                SuggestedId: c.Id))
            .ToList();

        return Task.FromResult<IReadOnlyList<DiscoveredNode>>(found);
    }
}
