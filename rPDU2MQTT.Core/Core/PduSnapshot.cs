using rPDU2MQTT.Models.PDU;

namespace rPDU2MQTT.Core;

/// <summary>
/// One poll's result from a single source, flowing producer → bus → consumers (v2 pipeline).
/// </summary>
/// <param name="InstanceId">Identifies the source PDU instance this snapshot came from.</param>
/// <param name="TimestampUtc">When the snapshot was produced.</param>
/// <param name="Data">The polled data (devices, outlets, entities, OneView groups).</param>
public sealed record PduSnapshot(string InstanceId, DateTime TimestampUtc, PduData Data);
