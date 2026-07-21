namespace rPDU2MQTT.Abstractions.Pdu;

/// <summary>A PDU device's base (non-outlet) data — the "base PDU data" child (framework-free wire DTO).</summary>
public sealed record DeviceState(
    string DeviceId,
    string? Name,
    string? DisplayName,
    string? Make,
    string? Model,
    string? State,
    DateTime UpdatedUtc,
    /// <summary>The PDU instance this device lives on, stamped by the polling PduGrain (null until polled).</summary>
    string? InstanceId = null);
