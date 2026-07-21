namespace rPDU2MQTT.Abstractions.Pdu;

/// <summary>
/// The children a PDU supervisor grain owns, derived from its latest poll: the device (base data) grains, the
/// outlet grains beneath them, and the OneView group grains it controls. Lets the parent report its own
/// subtree (diagnostics / the grain tree) — everything on this PDU, and nothing from any other one.
/// </summary>
public sealed record PduChildren(
    string InstanceId,
    List<string> Devices,
    List<string> Outlets,
    List<string>? Groups = null);
