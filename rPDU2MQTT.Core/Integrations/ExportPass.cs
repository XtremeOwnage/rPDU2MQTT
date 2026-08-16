using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Helpers;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Models.PDU;

namespace rPDU2MQTT.Core.Integrations;

/// <summary>
/// Everything a destination is offered on one export pass, built once and handed to all of them.
///
/// <para>
/// This exists because "send the energy-flow hierarchy too" used to be something each destination
/// remembered separately. EmonCMS never did, for its entire existence (#386) — the readings went, the
/// panels and inverters and batteries did not, and nothing failed because each exporter assembled its own
/// view of what there was to send. Passing one assembled object makes the hierarchy impossible to forget
/// and impossible to disagree about: a destination that ignores <see cref="Tiers"/> is visibly ignoring it.
/// </para>
/// <para>
/// Immutable, and shared between destinations on the same pass. Building it once also means the flow graph
/// is built once per poll rather than once per destination.
/// </para>
/// </summary>
/// <param name="Snapshot">Every fresh device, merged. Empty on an install with no PDU at all.</param>
/// <param name="Snapshots">
/// The same data unmerged, one per instance and each with the moment it was read. The merged view is what
/// the hierarchy needs (it spans instances); this is what anything publishing per-device state needs,
/// because a reading has to be stamped with when its OWN device was polled — merging gave every device one
/// timestamp, which is what Home Assistant's expire_after is judged against.
/// </param>
/// <param name="Readings">The snapshot flattened to numeric measurements.</param>
/// <param name="Tiers">One flow graph per exported metric — power, energy, and the daily total.</param>
/// <param name="AtUtc">When the pass was assembled.</param>
public sealed record ExportPass(
    PduData Snapshot,
    IReadOnlyList<MeasurementReading> Readings,
    IReadOnlyList<(string Metric, FlowGraph Graph)> Tiers,
    DateTime AtUtc,
    IReadOnlyList<PduSnapshot> Snapshots)
{
    /// <summary>Is there anything at all to send this pass?</summary>
    public bool IsEmpty => Readings.Count == 0 && Tiers.All(t => t.Graph.Nodes.Count == 0);

    /// <summary>
    /// The tiers a destination may carry, given its own tag filter. The filter chooses recipients; it never
    /// changes a value, and it has nothing to say about <see cref="Readings"/>.
    /// </summary>
    public IEnumerable<FlowTiers.Reading> TiersFor(NodeTagFilter? filter)
        => Tiers.SelectMany(t => FlowTiers.Of(t.Graph, filter));

    /// <summary>
    /// Assemble a pass from the fresh snapshots and the live flow values.
    /// </summary>
    public static ExportPass Build(IEnumerable<PduSnapshot> snapshots, Config cfg, IFlowValueSource? live)
    {
        var all = snapshots.ToList();
        var merged = new PduData();
        var readings = new List<MeasurementReading>();
        // Merged for the hierarchy (which spans instances), but each reading keeps the instance it came
        // from — that is the only thing the Prometheus `instance` label is built from.
        foreach (var s in all)
        {
            merged.Devices.AddRange(s.Data.Devices);
            readings.AddRange(MetricsHelper.EnumerateReadings(s.Data, s.InstanceId));
        }

        // A hierarchy that cannot be built must not take the readings down with it: the PDU half of every
        // destination keeps working, and the caller reports the gap rather than swallowing it.
        var tiers = FlowTiers.Any(merged, cfg)
            ? FlowTiers.Graphs(merged, cfg, live)
            : Array.Empty<(string, FlowGraph)>();

        return new ExportPass(merged, readings, tiers, DateTime.UtcNow, all);
    }
}
