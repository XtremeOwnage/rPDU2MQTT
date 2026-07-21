using Microsoft.Extensions.DependencyInjection;
using rPDU2MQTT.Classes;

namespace rPDU2MQTT.Grains.Pdu;

/// <summary>
/// Which PDU instance owns a device, outlet or group.
/// <para>
/// This solution bridges any number of PDUs, but a child grain has no PDU of its own: it has to be told which
/// one it belongs to. Resolving "the PDU" from DI yields the <i>primary</i> instance, so on a two-PDU setup
/// every write would be sent to the first PDU — actioning the wrong outlet, or none. The owning instance id
/// is therefore stamped on the state each <c>PduGrain</c> pushes to its children, and this picks the instance
/// to write through.
/// </para>
/// </summary>
public static class PduOwner
{
    /// <summary>
    /// The instance to write through: the one the child was bound to, as long as it's still configured;
    /// otherwise the primary (a child that hasn't been polled yet, or whose instance was removed). Null when
    /// nothing is configured at all.
    /// </summary>
    public static string? Choose(string? boundInstanceId, IEnumerable<string> configuredIds, string? primaryId)
    {
        var ids = configuredIds as ICollection<string> ?? configuredIds.ToList();

        if (!string.IsNullOrWhiteSpace(boundInstanceId)
            && ids.Contains(boundInstanceId!, StringComparer.OrdinalIgnoreCase))
            return ids.First(i => StringComparer.OrdinalIgnoreCase.Equals(i, boundInstanceId));

        if (!string.IsNullOrWhiteSpace(primaryId)
            && ids.Contains(primaryId!, StringComparer.OrdinalIgnoreCase))
            return primaryId;

        // No usable primary: with exactly one instance the answer is unambiguous anyway.
        return ids.Count == 1 ? ids.First() : null;
    }

    /// <summary>
    /// The PDU a child grain should write through. Falls back to the plain registered PDU when no instance
    /// registry is available (a bare test cluster), so the write path degrades instead of throwing.
    /// </summary>
    public static PDU? Resolve(IServiceProvider sp, string? instanceId)
    {
        var registry = sp.GetService<PduInstanceRegistry>();
        if (registry is null) return sp.GetService<PDU>();

        var all = registry.All;
        var chosen = Choose(instanceId, all.Keys, registry.PrimaryId);
        return chosen is not null && all.TryGetValue(chosen, out var pdu) ? pdu : sp.GetService<PDU>();
    }
}
