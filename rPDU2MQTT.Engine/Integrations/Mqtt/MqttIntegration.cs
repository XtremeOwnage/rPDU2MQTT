using System.Text.Json;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Core.Integrations;
using rPDU2MQTT.Helpers;
using rPDU2MQTT.Models.Config;

namespace rPDU2MQTT.Integrations.Mqtt;

/// <summary>
/// The energy hierarchy on the broker (#164): each tier's rolled-up power and energy on its own topic, and
/// the Home Assistant discovery document describing that topic.
///
/// <para>
/// Both capabilities, because the two are genuinely one job here: the discovery document describes the very
/// topic this integration publishes, and both need the same tier, the same parents and the same knowledge of
/// whether today's total was determined. Splitting them would mean walking the hierarchy twice and keeping
/// two copies of that reasoning in step.
/// </para>
/// <para>
/// The raw PDU publish — names, states, alarms, outlet config — is deliberately <b>not</b> here. That is the
/// bridge's core function rather than an export destination, and it publishes the PDU's whole object model
/// rather than an <see cref="ExportPass"/>.
/// </para>
/// </summary>
public sealed class MqttIntegration : IIntegration, IMeasurementDestination, IConfigurationPublisher
{
    private readonly Config cfg;
    private readonly IMessagePublisher publisher;
    private readonly IFlowValueSource? live;

    // Discovery config topics already retired, once per process: duplicates of a native sensor, and tiers
    // the tag filter now excludes.
    private readonly HashSet<string> clearedDuplicates = new();
    private readonly HashSet<string> retiredByFilter = new();
    /// <summary>What has already been published for each lifetime counter, so none of them goes backwards.</summary>
    private readonly Core.Flow.CumulativeExport cumulative;
    /// <summary>Keys already reported as withheld, so a stuck contributor is said once and not every pass.</summary>
    private readonly HashSet<string> saidWithheld = new();

    /// <param name="store">
    /// Where the published high-water marks live. Without one they are held in memory and every restart
    /// re-baselines them, which is read downstream as a meter reset — see <see cref="Core.Flow.CumulativeExport"/>.
    /// </param>
    public MqttIntegration(Config cfg, IMessagePublisher publisher, IFlowValueSource? live = null,
                           Core.Flow.IEnergyStore? store = null)
    {
        this.cfg = cfg;
        this.publisher = publisher;
        this.live = live;
        cumulative = store is null ? new() : new(store);
    }

    public string Id => "mqtt-energyflow";
    public string DisplayName => "MQTT energy flow";
    public IntegrationGroup Group => IntegrationGroup.Destinations;

    public bool Enabled(Config c) => c.EnergyFlow.MqttExport;

    public NodeTagFilter Tags(Config c) => c.EnergyFlow.MqttExportTags;

    public Task<(bool Ok, string Detail)> ProbeAsync(Config c, CancellationToken ct)
        => Task.FromResult((true, $"publishing to {c.MQTT.ParentTopic}"));

    // Discovery documents describe what exists, so they are configuration; they ride the same walk as the
    // state topics because both need the same tier, parents and period-readiness.
    public bool PublishingEnabled(Config c) => c.EnergyFlow.MqttExport && c.HASS.DiscoveryEnabled;

    public Task SendAsync(ExportPass pass, CancellationToken ct) => PublishTiers(pass, ct);

    public async Task<string> PublishAsync(ExportPass pass, CancellationToken ct)
    {
        var n = await PublishTiers(pass, ct);
        return $"Published {n} energy-flow tier(s) and their discovery documents.";
    }

    private async Task<int> PublishTiers(ExportPass pass, CancellationToken ct)
    {
        var flow = cfg.EnergyFlow;
        if (!flow.MqttExport || pass.Tiers.Count == 0) return 0;

        // Power defines the hierarchy and the topics; the other graphs are the same roll-up over their metric.
        var graph = pass.Tiers[0].Graph;
        var energyGraph = pass.Tiers.Count > 1 ? pass.Tiers[1].Graph : graph;
        var todayGraph = pass.Tiers.Count > 2 ? pass.Tiers[2].Graph : graph;
        var energyMetric = pass.Tiers.Count > 1 ? pass.Tiers[1].Metric : "energy";

        // ...but a daily total is not reported until the carried-over totals are back.
        var periodsReady = (live as IPeriodTotalsReady)?.PeriodTotalsReady ?? true;

        var publishDiscovery = cfg.HASS.DiscoveryEnabled && !string.IsNullOrWhiteSpace(cfg.HASS.DiscoveryTopic);
        var availability = cfg.MQTT.LastWill ? MQTTHelper.StatusTopic(cfg.MQTT.ParentTopic) : null;
        // Outlets and PDU tiers already have native HA energy sensors from PDU discovery.
        var native = FlowExport.NativeEnergyUniqueIds(pass.Snapshot, energyMetric);

        // Nodes that declare an in-direction (charge/export) energy source get a second energy sensor.
        var energyInNodes = flow.Nodes
            .Where(n => n.AllSources().Any(s =>
                string.Equals(s.Metric, energyMetric, StringComparison.OrdinalIgnoreCase) &&
                (string.Equals(s.Direction, "in", StringComparison.OrdinalIgnoreCase) || FlowMetricKey.IsSplit(s.Direction))))
            .Select(n => n.Id)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        // Nodes with a state-of-charge source (battery %) get an extra SoC sensor HA's battery source can use.
        var socNodes = flow.Nodes
            .Where(n => n.AllSources().Any(s => string.Equals(s.Metric, "soc", StringComparison.OrdinalIgnoreCase)))
            .Select(n => n.Id)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        var tagFilter = flow.MqttExportTags;
        var published = 0;

        // Synthetic nodes are for the diagram only — see FlowNode.Synthetic.
        foreach (var node in graph.Nodes.Where(n => !n.Synthetic))
        {
            // Tag filter (#342): what this destination receives.
            if (!tagFilter.Allows(node.Tags))
            {
                // Retire the discovery config with it.
                if (publishDiscovery)
                {
                    var excludedTopic = $"{cfg.HASS.DiscoveryTopic}/device/{FlowExport.DeviceId(node.Id)}/config";
                    if (retiredByFilter.Add(excludedTopic))
                        await publisher.PublishAsync(excludedTopic, string.Empty, retain: true, ct, pass.AtUtc);
                }
                continue;
            }

            // Nothing determines this tier's power — no measurement.
            if (!FlowExport.TryNodeValue(graph, node.Id, out var power))
                continue;

            var topic = FlowExport.Topic(node, graph, cfg.MQTT.ParentTopic, flow);
            // Null — not 0 — when nothing determines it, exactly like energy_in / energy_today / soc below.
            // The sensor this feeds is state_class total_increasing, and to Home Assistant a series that
            // drops to zero is a meter reset: the next real reading is taken as a delta from zero and an
            // entire lifetime counter lands on one day's bar.
            // …and never a figure below one already published: a roll-up dips whenever a contributor goes
            // stale, because the sum only covers the links that are known.
            double? energy = cumulative.Publish($"{node.Id}|energy",
                FlowExport.TryNodeValue(energyGraph, node.Id, out var e) ? e : null);
            // Only feeders that are themselves being exported.
            var parents = FlowExport.Parents(graph, node.Id)
                .Where(pid => graph.Nodes.FirstOrDefault(n => string.Equals(n.Id, pid, StringComparison.OrdinalIgnoreCase)) is not { } pn
                              || tagFilter.Allows(pn.Tags))
                .ToList();

            // The in-direction (charge/export) energy, when this node declares one and a fresh value exists.
            double? energyIn = cumulative.Publish($"{node.Id}|energy_in",
                energyInNodes.Contains(node.Id) && live is not null
                && live.TryGetValue(node.Id, FlowMetricKey.For(energyMetric, "in"), out var ein) ? ein : null);

            // Today's total. Null — not 0 — when nothing determines it.
            double? energyToday = FlowExport.PeriodTotal(todayGraph, node.Id, periodsReady);

            // Signed net power for a bidirectional node: out (discharge/import) minus in (charge/export).
            double netPower = live is not null && live.TryGetValue(node.Id, FlowMetricKey.For("realpower", "in"), out var pin) ? power - pin : power;
            // Battery state of charge (%), when this node has a soc source with a fresh value.
            double? soc = socNodes.Contains(node.Id) && live is not null && live.TryGetValue(node.Id, "soc", out var s) ? s : null;

            var payload = JsonSerializer.Serialize(new
            {
                id = node.Id,
                value = netPower,    // retained for #164 back-compat (== power)
                power = netPower,
                energy,
                energy_in = energyIn,
                energy_today = energyToday,
                soc,
                units = graph.Units,
                energyUnits = energyGraph.Units,
                label = node.Label,
                kind = node.Kind,
                parents,
                // #205: this payload is already JSON, so the read time can just be a field — no mode needed.
                timestamp = Core.MessageTimestamps.Format(pass.AtUtc),
            });
            await publisher.PublishAsync(topic, payload, retain: true, ct, pass.AtUtc);
            published++;

            if (!publishDiscovery)
                continue;

            var configTopic = $"{cfg.HASS.DiscoveryTopic}/device/{FlowExport.DeviceId(node.Id)}/config";
            if (native.ContainsKey(node.Id))
            {
                // Native sensor exists — retire any duplicate an earlier build left retained (once).
                if (clearedDuplicates.Add(configTopic))
                    await publisher.PublishAsync(configTopic, string.Empty, retain: true, ct, pass.AtUtc);
            }
            else
            {
                var doc = FlowExport.DiscoveryDocument(node, parents.FirstOrDefault(), topic, energyGraph.Units, graph.Units, availability,
                    includeEnergyIn: energyInNodes.Contains(node.Id), includeSoc: socNodes.Contains(node.Id),
                    includeEnergyToday: energyToday is not null);
                await publisher.PublishAsync(configTopic, doc.ToJsonString(), retain: cfg.HASS.DiscoveryRetain, ct, pass.AtUtc);
            }
        }

        // Node groups (#groups): each group publishes its own summed tier alongside its members.
        foreach (var g in flow.Groups ?? new())
        {
            if (string.IsNullOrWhiteSpace(g.Id)) continue;
            // An anchor group's id is a real node that already published its own tier above, so skip it.
            if (graph.Nodes.Any(n => string.Equals(n.Id, g.Id, StringComparison.OrdinalIgnoreCase))) continue;

            var total = FlowGroups.Total(graph, g);
            if (total.Value is not { } gpower) continue;

            // Null, not 0, and never below what was published before — the group's Energy sensor is the
            // same state_class total_increasing as a tier's.
            double? genergy = cumulative.Publish($"group:{g.Id}|energy", FlowGroups.Total(energyGraph, g).Value);
            var groupNode = new FlowNode(total.Id, total.Label, total.Kind, gpower);
            var gtopic = FlowExport.Topic(groupNode, graph, cfg.MQTT.ParentTopic, flow);

            var gpayload = JsonSerializer.Serialize(new
            {
                id = g.Id,
                value = gpower,
                power = gpower,
                energy = genergy,
                units = graph.Units,
                energyUnits = energyGraph.Units,
                label = total.Label,
                kind = total.Kind,
                group = true,
                members = g.Members,
                timestamp = Core.MessageTimestamps.Format(pass.AtUtc),
            });
            await publisher.PublishAsync(gtopic, gpayload, retain: true, ct, pass.AtUtc);
            published++;

            if (!publishDiscovery) continue;

            var gconfig = $"{cfg.HASS.DiscoveryTopic}/device/{FlowExport.DeviceId(g.Id)}/config";
            var gdoc = FlowExport.DiscoveryDocument(groupNode, null, gtopic, energyGraph.Units, graph.Units, availability);
            await publisher.PublishAsync(gconfig, gdoc.ToJsonString(), retain: cfg.HASS.DiscoveryRetain, ct, pass.AtUtc);
        }

        // A counter held back is said once, when it starts, and once when it recovers. Silence is what let a
        // roll-up publish a smaller total for a week without anyone knowing it had.
        foreach (var (key, reason) in cumulative.Withheld)
            if (saidWithheld.Add(key))
                Log.Warning($"Holding back {key}: {reason}");
        foreach (var key in saidWithheld.ToList())
            if (!cumulative.Withheld.Any(w => w.Key == key))
            {
                Log.Information($"{key} is being published again — it has passed the figure it dipped below.");
                saidWithheld.Remove(key);
            }

        return published;
    }
}
