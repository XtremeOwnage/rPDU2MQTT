using System.Text.Json.Nodes;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Models.PDU;

namespace rPDU2MQTT.Core.Flow;

/// <summary>
/// Helpers for exporting an energy-hierarchy (<see cref="FlowGraph"/>) to MQTT (#164): each tier's
/// rolled-up value and the topic it publishes to.
/// </summary>
public static class FlowExport
{
    /// <summary>
    /// A node's rolled-up value, or 0 when the graph could not determine one.
    /// <para>
    /// The builder computes this now (see <see cref="FlowNode.Value"/>), so exports agree with the diagram
    /// instead of re-deriving it. Callers that must distinguish "unknown" from "zero" — anything that
    /// publishes a reading — should read <see cref="FlowNode.Value"/> and skip nulls; see
    /// <see cref="TryNodeValue"/>.
    /// </para>
    /// </summary>
    public static double NodeValue(FlowGraph graph, string id)
        => TryNodeValue(graph, id, out var value) ? value : 0;

    /// <summary>
    /// The node's value when the graph actually determined one. False means nothing measures this node and
    /// nothing downstream determines it — publishing a number for it would be inventing one.
    /// </summary>
    public static bool TryNodeValue(FlowGraph graph, string id, out double value)
    {
        var node = graph.Nodes.FirstOrDefault(n => string.Equals(n.Id, id, StringComparison.OrdinalIgnoreCase));
        if (node?.Value is { } known) { value = known; return true; }

        // No value on the node: derive it from the links whose flow is known (the larger of in vs. out).
        // A node the builder marked unknown has only unknown links, so this correctly finds nothing —
        // while a graph assembled by hand, whose nodes carry no values, still resolves.
        double inflow = 0, outflow = 0;
        var anyKnown = false;
        foreach (var l in graph.Links)
        {
            if (!l.Known) continue;
            if (string.Equals(l.Target, id, StringComparison.OrdinalIgnoreCase)) { inflow += l.Value; anyKnown = true; }
            if (string.Equals(l.Source, id, StringComparison.OrdinalIgnoreCase)) { outflow += l.Value; anyKnown = true; }
        }
        value = anyKnown ? Math.Max(inflow, outflow) : 0;
        return anyKnown;
    }

    /// <summary>The ids of a node's feeders (the sources of links pointing into it) — its upstream parents.</summary>
    public static string[] Parents(FlowGraph graph, string id)
        => graph.Links
            .Where(l => string.Equals(l.Target, id, StringComparison.OrdinalIgnoreCase))
            .Select(l => l.Source)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();

    /// <summary>The MQTT topic a tier publishes to, with {parent}/{id}/{label}/{kind}/{metric}/{units} filled in.</summary>
    public static string Topic(FlowNode node, FlowGraph graph, string parentTopic, EnergyFlowConfig cfg)
    {
        var template = string.IsNullOrWhiteSpace(cfg.MqttTopicTemplate) ? "{parent}/energyflow/{id}" : cfg.MqttTopicTemplate;
        var topic = template
            .Replace("{parent}", (parentTopic ?? string.Empty).Trim('/'))
            .Replace("{id}", NodeKey(node.Id))
            .Replace("{label}", NodeKey(node.Label))
            .Replace("{kind}", node.Kind)
            .Replace("{metric}", graph.Metric)
            .Replace("{units}", graph.Units);
        // Collapse empty/duplicate slashes (e.g. an unused placeholder that resolved to empty).
        return string.Join('/', topic.Split('/', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
    }

    /// <summary>A stable, topic/id-safe key for a node id: ':' (outlet:pdu:n) and other separators -> '_'.</summary>
    public static string NodeKey(string value)
        => new((value ?? string.Empty).Select(c => char.IsLetterOrDigit(c) || c is '-' or '_' ? c : '_').ToArray());

    /// <summary>The Home Assistant device identifier for a tier ("energyflow_&lt;key&gt;").</summary>
    public static string DeviceId(string nodeId) => "energyflow_" + NodeKey(nodeId);

    /// <summary>The HA unique_id / entity object_id of a tier's energy sensor ("energyflow_&lt;key&gt;_energy").
    /// This is the <c>out</c> (supply) direction — discharge/import/production — the sensor every tier already
    /// carries.</summary>
    public static string EnergyUniqueId(string nodeId) => DeviceId(nodeId) + "_energy";

    /// <summary>The HA unique_id of a tier's <c>in</c>-direction energy sensor ("energyflow_&lt;key&gt;_energy_in")
    /// — battery charge / grid export. Distinct from <see cref="EnergyUniqueId"/> so both directions can map to
    /// Home Assistant's battery/grid split.</summary>
    public static string EnergyInUniqueId(string nodeId) => DeviceId(nodeId) + "_energy_in";

    /// <summary>The HA unique_id of a tier's power sensor ("energyflow_&lt;key&gt;_power"). Signed for a
    /// bidirectional node (grid/battery): positive supplying, negative drawing — what HA's stat_rate expects.</summary>
    public static string PowerUniqueId(string nodeId) => DeviceId(nodeId) + "_power";

    /// <summary>The HA unique_id of a battery tier's state-of-charge sensor ("energyflow_&lt;key&gt;_soc").</summary>
    public static string SocUniqueId(string nodeId) => DeviceId(nodeId) + "_soc";

    /// <summary>The discovery-topic prefix every device this exporter publishes is named with.</summary>
    public const string DeviceIdPrefix = "energyflow_";

    /// <summary>
    /// The discovery device ids the MQTT export publishes right now: every non-synthetic node the tag
    /// filter allows, minus those already covered by native PDU discovery.
    /// </summary>
    /// <remarks>
    /// Shared with the orphan sweep so the two agree. A node the exporter has stopped publishing must not
    /// count as current, or its retained config is never swept and the device stays in Home Assistant with
    /// a state topic that no longer updates.
    /// </remarks>
    public static IReadOnlyList<string> ExportedDeviceIds(
        FlowGraph graph, Models.Config.NodeTagFilter? tagFilter, IReadOnlyDictionary<string, string>? nativeIds = null)
        => [.. graph.Nodes
            .Where(n => !n.Synthetic)
            .Where(n => tagFilter is null || tagFilter.Allows(n.Tags))
            .Where(n => nativeIds is null || !nativeIds.ContainsKey(n.Id))
            .Select(n => DeviceId(n.Id))];


    /// <summary>
    /// Retained Home Assistant discovery configs this exporter published and would no longer publish today —
    /// the ones to clear.
    ///
    /// <para>
    /// A discovery config is retained, so it outlives the thing it described. An outlet that gains a native
    /// energy sensor (so the flow export correctly stops publishing a duplicate for it), a node renamed, a
    /// tier deleted from the hierarchy — each leaves its config sitting on the broker, and Home Assistant
    /// goes on showing the device as though it were real. Seen on a live system: fifteen orphaned devices,
    /// several of them a second and third copy of an outlet that already had one.
    /// </para>
    /// <para>
    /// Nothing revisits them on its own. The publish loop only ever walks the nodes that exist <em>now</em>,
    /// so a config for something that no longer exists is unreachable by construction — it can only be found
    /// by looking at what is actually retained and subtracting what we mean to publish.
    /// </para>
    /// <para>
    /// Deliberately narrow: only topics under the discovery prefix, only the <c>device</c> component, and only
    /// ids beginning with <see cref="DeviceIdPrefix"/>. Another integration's discovery — or this project's own
    /// native PDU discovery, which a different service owns — must never be touched by this.
    /// </para>
    /// </summary>
    /// <param name="retainedTopics">Every retained topic currently on the broker.</param>
    /// <param name="currentDeviceIds">The device ids the exporter would publish right now.</param>
    /// <param name="discoveryPrefix">The configured Home Assistant discovery prefix (e.g. "homeassistant").</param>
    public static IReadOnlyList<string> OrphanedDiscoveryTopics(
        IEnumerable<string> retainedTopics, IEnumerable<string> currentDeviceIds, string discoveryPrefix)
        => OrphanedDiscoveryTopics(retainedTopics, currentDeviceIds, discoveryPrefix, DeviceIdPrefix);

    /// <summary>
    /// The same scan for a different family of device ids — native PDU discovery uses the configured root
    /// identifier rather than <see cref="DeviceIdPrefix"/>.
    /// </summary>
    /// <param name="deviceIdPrefix">
    /// Only ids starting with this are considered. It is the entire safety boundary: everything else on the
    /// broker belongs to another integration, and clearing one of those deletes someone's devices out of
    /// Home Assistant with nothing to put them back.
    /// </param>
    public static IReadOnlyList<string> OrphanedDiscoveryTopics(
        IEnumerable<string> retainedTopics, IEnumerable<string> currentDeviceIds, string discoveryPrefix,
        string deviceIdPrefix)
    {
        if (string.IsNullOrWhiteSpace(deviceIdPrefix)) return Array.Empty<string>();
        var keep = new HashSet<string>(currentDeviceIds, StringComparer.OrdinalIgnoreCase);
        var root = (discoveryPrefix ?? "").Trim().Trim('/');
        if (root.Length == 0) return Array.Empty<string>();

        var orphans = new List<string>();
        foreach (var topic in retainedTopics)
        {
            if (string.IsNullOrWhiteSpace(topic)) continue;
            var parts = topic.Split('/');
            // <root>/device/<id>/config — anything else is not ours to reason about.
            if (parts.Length != 4) continue;
            if (!string.Equals(parts[0], root, StringComparison.OrdinalIgnoreCase)) continue;
            if (!string.Equals(parts[1], "device", StringComparison.OrdinalIgnoreCase)) continue;
            if (!string.Equals(parts[3], "config", StringComparison.OrdinalIgnoreCase)) continue;

            var id = parts[2];
            if (!id.StartsWith(deviceIdPrefix, StringComparison.OrdinalIgnoreCase)) continue;
            if (keep.Contains(id)) continue;

            orphans.Add(topic);
        }
        return orphans;
    }

    /// <summary>
    /// Flow node id -> the unique_id of the native PDU-discovery energy sensor it already has (#177): PDU
    /// tiers (<c>pdu:{name}</c>) and outlets (<c>outlet:{name}:{key}</c>) that carry an energy measurement.
    /// These already exist in HA, so the flow export must not publish a duplicate energyflow sensor for
    /// them — only the synthetic hierarchy tiers (panels/circuits/etc.) need one.
    /// </summary>
    public static Dictionary<string, string> NativeEnergyUniqueIds(PduData data, string energyType)
    {
        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        string? UniqueId(IEnumerable<Measurement> measurements) =>
            measurements.FirstOrDefault(m => string.Equals(m.Type, energyType, StringComparison.OrdinalIgnoreCase))?.Entity_Identifier is { Length: > 0 } uid
                ? uid
                : null;

        foreach (var device in data.Devices)
        {
            if (UniqueId(device.Entity.SelectMany(e => e.Measurements)) is { } pduUid)
                map[$"pdu:{device.Entity_Name}"] = pduUid;
            foreach (var outlet in device.Outlets)
                if (UniqueId(outlet.Measurements) is { } outletUid)
                    map[$"outlet:{device.Entity_Name}:{outlet.Key}"] = outletUid;
        }
        return map;
    }

    /// <summary>
    /// A Home Assistant device-discovery document for a tier (#128): one device with an Energy sensor
    /// (kWh, total_increasing — so it can feed the Energy Dashboard) and a Power sensor (W), both reading
    /// <c>value_json.energy</c> / <c>value_json.power</c> from the tier's exported MQTT topic. Publishing
    /// these makes the whole hierarchy — not just leaf outlets — visible to HA and linkable in the dashboard.
    /// </summary>
    public static JsonObject DiscoveryDocument(FlowNode node, string? primaryParentId, string stateTopic,
        string energyUnits, string powerUnits, string? availabilityTopic, bool includeEnergyIn = false, bool includeSoc = false,
        bool includeEnergyToday = false)
    {
        var id = DeviceId(node.Id);
        var device = new JsonObject
        {
            ["identifiers"] = new JsonArray(id),
            ["name"] = node.Label,
            ["manufacturer"] = "rPDU2MQTT",
            ["model"] = $"Energy Flow ({node.Kind})",
        };
        if (!string.IsNullOrEmpty(primaryParentId))
            device["via_device"] = DeviceId(primaryParentId);

        static JsonObject Sensor(string uniqueId, string name, string deviceClass, string stateClass, string units, string template) => new()
        {
            ["platform"] = "sensor",
            ["name"] = name,
            ["unique_id"] = uniqueId,
            ["object_id"] = uniqueId,
            ["device_class"] = deviceClass,
            ["state_class"] = stateClass,
            ["unit_of_measurement"] = units,
            ["value_template"] = template,
        };

        var doc = new JsonObject
        {
            ["device"] = device,
            ["origin"] = new JsonObject { ["name"] = "rPDU2MQTT" },
            ["state_topic"] = stateTopic,
            ["qos"] = 0,
            ["components"] = new JsonObject
            {
                [$"{id}_energy"] = Sensor($"{id}_energy", "Energy", "energy", "total_increasing", string.IsNullOrWhiteSpace(energyUnits) ? "kWh" : energyUnits, "{{ value_json.energy }}"),
                [$"{id}_power"] = Sensor($"{id}_power", "Power", "power", "measurement", string.IsNullOrWhiteSpace(powerUnits) ? "W" : powerUnits, "{{ value_json.power }}"),
            },
        };
        // A bidirectional node (battery/grid) also carries its in-direction energy — charge / export — as a
        // second total_increasing sensor, which is what lets HA's Energy Dashboard show battery charge and
        // grid return. Its unique_id matches EnergyInUniqueId so the dashboard sync can resolve it.
        if (includeEnergyIn)
            doc["components"]!.AsObject()[$"{id}_energy_in"] =
                Sensor($"{id}_energy_in", "Energy In", "energy", "total_increasing", string.IsNullOrWhiteSpace(energyUnits) ? "kWh" : energyUnits, "{{ value_json.energy_in }}");
        // Energy since local midnight. total_increasing rather than total+last_reset: HA reads the drop at
        // rollover as a meter reset and starts a new day, which is exactly the semantics, and it avoids
        // having to publish a last_reset timestamp that must then agree with our rollover to the second.
        if (includeEnergyToday)
            doc["components"]!.AsObject()[$"{id}_energy_today"] =
                Sensor($"{id}_energy_today", "Energy today", "energy", "total_increasing", string.IsNullOrWhiteSpace(energyUnits) ? "kWh" : energyUnits, "{{ value_json.energy_today }}");
        // A battery tier with a state-of-charge source publishes it too, so HA's battery source can show %.
        if (includeSoc)
            doc["components"]!.AsObject()[$"{id}_soc"] =
                Sensor($"{id}_soc", "State of charge", "battery", "measurement", "%", "{{ value_json.soc }}");
        if (!string.IsNullOrEmpty(availabilityTopic))
            doc["availability_topic"] = availabilityTopic;
        return doc;
    }
}
