namespace rPDU2MQTT.Abstractions.Pdu;

/// <summary>
/// The children a PDU supervisor grain owns, derived from its latest poll: the device (base data) grains and
/// the outlet grains beneath them. Lets the parent report its own subtree (diagnostics / the grain tree).
/// </summary>
public sealed record PduChildren(
    string InstanceId,
    List<string> Devices,
    List<string> Outlets);
