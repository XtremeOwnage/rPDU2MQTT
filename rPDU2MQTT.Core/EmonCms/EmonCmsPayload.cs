using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Helpers;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Models.PDU;

namespace rPDU2MQTT.Core.EmonCms;

/// <summary>
/// What an EmonCMS export pass sends: input key -> value, keyed by the payload it belongs to
/// (<see cref="Combined"/> for the single payload, or a device name when the MQTT topic template splits
/// per PDU).
///
/// <para>
/// Deliberately separate from the service that posts it. The energy-flow half of this payload was missing
/// for its entire existence and nothing failed, because every test in reach exercised the graph rather than
/// what was sent from it. Composition that lives here is composition a test can hold to account; the
/// service is left with the sending, which is all it should ever have decided.
/// </para>
/// </summary>
public static class EmonCmsPayload
{
    /// <summary>The key of the one payload that is not split per device.</summary>
    public const string Combined = "";

    /// <summary>
    /// Build the pass's payloads from the fresh snapshots and the live flow values.
    /// </summary>
    /// <param name="warn">Reports a hierarchy that could not be built; the readings still go without it.</param>
    public static Dictionary<string, Dictionary<string, double>> Build(
        IEnumerable<PduData> snapshots, Config config, IFlowValueSource? live, Action<string>? warn = null)
    {
        var c = config.EmonCMS;
        // Normally one combined payload (input keys are unique per device), but when the MQTT topic template
        // contains {device} (#165) we split per PDU so each goes to its own topic. The HTTP transport always
        // posts one combined payload — the split is a topic concept.
        var splitByDevice = c.Transport == EmonCmsTransport.Mqtt && MetricsHelper.EmonCmsSplitsByDevice(config);

        var payloads = new Dictionary<string, Dictionary<string, double>>();
        var merged = new PduData();

        Dictionary<string, double> Payload(string key)
        {
            if (!payloads.TryGetValue(key, out var values)) payloads[key] = values = new();
            return values;
        }

        foreach (var data in snapshots)
        {
            merged.Devices.AddRange(data.Devices);
            foreach (var r in MetricsHelper.EnumerateReadings(data))
                Payload(splitByDevice ? r.Device : Combined)[MetricsHelper.EmonCmsInputName(r, config)] = r.Value;
        }

        // The hierarchy itself — the panels, inverters, batteries and totals a PDU knows nothing about.
        // They have no device, so they ride in the combined payload however the readings are split.
        foreach (var (name, value) in FlowInputs(merged, config, live, warn))
            Payload(Combined)[name] = value;

        return payloads;
    }

    /// <summary>
    /// Every energy-flow tier's input key and value, for each exported metric (power, energy, today).
    /// </summary>
    public static IReadOnlyList<(string Name, double Value)> FlowInputs(
        PduData merged, Config config, IFlowValueSource? live, Action<string>? warn = null)
    {
        var c = config.EmonCMS;
        if (!c.ExportFlowNodes || !FlowTiers.Any(merged, config)) return Array.Empty<(string, double)>();

        try
        {
            return FlowTiers.Graphs(merged, config, live)
                .SelectMany(g => FlowTiers.Of(g.Graph, c.NodeTags))
                .Select(t => (MetricsHelper.EmonCmsFlowInputName(t.Node.Id, t.Node.Label, t.Node.Kind, t.Metric, config), t.Value))
                .ToList();
        }
        catch (Exception ex)
        {
            // A hierarchy that cannot be built is worth saying out loud: the readings still go, and silence
            // about everything else is exactly what made the missing half so hard to notice.
            warn?.Invoke($"EmonCMS: could not build the energy-flow hierarchy this pass, so only the PDU readings were sent ({ex.Message}).");
            return Array.Empty<(string, double)>();
        }
    }
}
