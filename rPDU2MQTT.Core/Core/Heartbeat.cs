namespace rPDU2MQTT.Core;

/// <summary>
/// The EmonCMS exporter's last-known health, carried on a process's registration (v3: the
/// ProcessRegistryGrain) so a split API/UI node can show the true export status on the Status board.
/// Only the process actually exporting sets it. (Formerly carried on the MQTT heartbeat.)
/// </summary>
public sealed record EmonCmsHealth(bool? Ok, DateTime? LastAttemptUtc, DateTime? LastSuccessUtc, string? LastError, int Count);
