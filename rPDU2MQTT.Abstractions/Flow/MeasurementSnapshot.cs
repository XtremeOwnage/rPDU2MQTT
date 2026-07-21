using rPDU2MQTT.Abstractions.Pipeline;

namespace rPDU2MQTT.Abstractions.Flow;

/// <summary>
/// One measured value a source contributes: the flow <b>node</b> it targets, the <see cref="Metric"/>, the
/// value (already in the metric's canonical unit — the source adapter applies scale/unit at the edge), and
/// how long it stays valid. Note the node is the addressed entity and the metric is a field of that address:
/// <c>(NodeId, Metric)</c> is the data key; the node — not the metric — is what becomes an actor later.
/// </summary>
public readonly record struct MeasurementReading(string NodeId, Metric Metric, double Value, int StaleAfterSeconds);

/// <summary>
/// A source's contribution to the flow, ready for the middleware: the readings it currently has, already
/// mapped to <c>(node, metric)</c> in canonical units. This is the snapshot that flows <b>source →
/// middleware</b>. The source that emits it (Modbus device, MQTT ingest, …) has done the binding/scaling, so
/// the middleware stays source-agnostic — it only ever sees nodes and metrics.
/// </summary>
public sealed record MeasurementSnapshot(
    string SourceId,
    DateTimeOffset TimestampUtc,
    long Version,
    IReadOnlyList<MeasurementReading> Readings) : ISnapshot;
