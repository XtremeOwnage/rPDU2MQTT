namespace rPDU2MQTT.Abstractions.Pdu;

/// <summary>
/// One outlet's current observed state (framework-free wire DTO). Held by an OutletGrain and fed from the
/// PDU poll — carries no Orleans attributes; shipped across grains via the JSON serializer like the flow
/// measurements.
/// </summary>
public sealed record OutletState(
    string DeviceId,
    int Index,
    string? Name,
    string? DisplayName,
    string? PowerState,
    DateTime UpdatedUtc);
