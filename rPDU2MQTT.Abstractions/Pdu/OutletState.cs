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
    DateTime UpdatedUtc,
    /// <summary>
    /// The PDU instance this outlet lives on, stamped by the polling PduGrain. With several PDUs bridged,
    /// this is what routes a write to the PDU that actually has the outlet. Null until the first poll.
    /// </summary>
    string? InstanceId = null);
