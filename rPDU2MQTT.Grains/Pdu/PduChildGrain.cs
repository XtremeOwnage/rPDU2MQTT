using rPDU2MQTT.Grains.Abstractions.Pdu;

namespace rPDU2MQTT.Grains.Pdu;

/// <summary>
/// Base for the PDU's child grains (outlets, groups): a child knows which PDU it belongs to, because its
/// parent tells it and it keeps it — and it reaches that PDU by calling the parent, never by going and
/// finding one.
/// <para>
/// This matters because there are several PDUs. A child that resolves "the PDU" for itself — out of the
/// container, out of a registry — is guessing, and the guess is the primary instance, so on any other PDU
/// the write lands on the wrong device or nowhere. Here the owner is state handed down with the poll, and
/// the parent grain (whose key <i>is</i> the instance id) is the only thing holding a connection.
/// </para>
/// </summary>
public abstract class PduChildGrain : Grain
{
    /// <summary>The PDU instance this child belongs to, as last stamped by its parent.</summary>
    protected string? Owner { get; private set; }

    /// <summary>Remember the owning instance. Ignores a blank so a partial update can't orphan the child.</summary>
    protected void BindOwner(string? instanceId)
    {
        if (!string.IsNullOrWhiteSpace(instanceId)) Owner = instanceId;
    }

    /// <summary>
    /// The PDU grain this child belongs to — the one thing that talks to the device. Null until the parent
    /// has claimed this child (nothing has been polled yet), which is the only honest answer at that point:
    /// we don't know which PDU it's on, so we don't write to any of them.
    /// </summary>
    protected IPduGrain? Parent
        => string.IsNullOrWhiteSpace(Owner) ? null : GrainFactory.GetGrain<IPduGrain>(Owner!);
}
