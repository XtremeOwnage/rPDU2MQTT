using Microsoft.Extensions.DependencyInjection;
using rPDU2MQTT.Classes;

namespace rPDU2MQTT.Grains.Pdu;

/// <summary>
/// Base for the PDU's child grains (outlets, groups): a child knows which PDU it belongs to, because its
/// parent tells it on every poll and it keeps it.
/// <para>
/// This solution bridges any number of PDUs, and a child has no PDU of its own. Resolving "the PDU" from DI
/// yields the <i>primary</i> instance, so on anything but a single-PDU setup every write went to the first
/// PDU — actioning the wrong outlets, or none. Holding the owner as state fixes that at the source: the
/// child writes through the PDU it came from.
/// </para>
/// </summary>
public abstract class PduChildGrain : Grain
{
    private readonly IServiceProvider sp;

    protected PduChildGrain(IServiceProvider sp) => this.sp = sp;

    /// <summary>The PDU instance this child belongs to, as last stamped by its parent.</summary>
    protected string? Owner { get; private set; }

    /// <summary>Remember the owning instance. Ignores a blank so a partial update can't orphan the child.</summary>
    protected void BindOwner(string? instanceId)
    {
        if (!string.IsNullOrWhiteSpace(instanceId)) Owner = instanceId;
    }

    /// <summary>The PDU to write through — this child's own. Null when there's no PDU at all to write to.</summary>
    protected PDU? Pdu
    {
        get
        {
            var registry = sp.GetService<PduInstanceRegistry>();
            // No instance registry (a bare test cluster): fall back to whatever single PDU is registered.
            return registry is null ? sp.GetService<PDU>() : PduFor(registry, Owner);
        }
    }

    /// <summary>
    /// The instance a child with this owner writes through. Its own while that instance is configured;
    /// otherwise the primary — which covers a child whose parent hasn't polled yet, and a child whose
    /// instance was removed from config. On a single-PDU install the two are the same thing.
    /// </summary>
    public static PDU? PduFor(PduInstanceRegistry registry, string? owner)
    {
        var all = registry.All;   // keyed case-insensitively, like the config
        if (!string.IsNullOrWhiteSpace(owner) && all.TryGetValue(owner!, out var mine)) return mine;
        return all.TryGetValue(registry.PrimaryId, out var primary) ? primary : all.Values.FirstOrDefault();
    }
}
