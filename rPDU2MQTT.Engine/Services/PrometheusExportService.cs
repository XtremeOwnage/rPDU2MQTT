using Prometheus;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Helpers;
using rPDU2MQTT.Services.baseTypes;

namespace rPDU2MQTT.Services;

/// <summary>
/// Publishes PDU measurements as Prometheus metrics. Each measurement type becomes a gauge
/// (e.g. rpdu2mqtt_realpower) labelled by device and source. Can expose a /metrics endpoint for
/// scraping (Exporter) and/or push to a Pushgateway (Pushgateway) — both independent.
/// </summary>
public class PrometheusExportService : baseMQTTService
{
    private readonly Dictionary<string, Gauge> gauges = new();
    private readonly IMetricServer? exporter;
    private readonly IMetricServer? pusher;
    private readonly Core.Flow.IFlowValueSource? live;

    public PrometheusExportService(MQTTServiceDependencies deps, Core.Flow.IFlowValueSource? live = null) : base(deps, deps.Cfg.Primary.PollInterval)
    {
        this.live = live;
        var cfg = deps.Cfg.Prometheus;

        if (cfg.Exporter)
        {
            try
            {
                exporter = new MetricServer(port: cfg.Port).Start();
                Log.Information($"Prometheus exporter listening on :{cfg.Port}/metrics");
            }
            catch (Exception ex)
            {
                Log.Error(ex, $"Failed to start the Prometheus exporter on port {cfg.Port}.");
            }
        }

        if (cfg.Pushgateway.Enabled)
        {
            if (string.IsNullOrWhiteSpace(cfg.Pushgateway.Url))
            {
                Log.Error("Prometheus Pushgateway is enabled but Prometheus.Pushgateway.Url is not set; no metrics will be pushed.");
            }
            else
            {
                try
                {
                    var seconds = cfg.Pushgateway.IntervalSeconds > 0 ? cfg.Pushgateway.IntervalSeconds : deps.Cfg.Primary.PollInterval;
                    pusher = new MetricPusher(new MetricPusherOptions
                    {
                        Endpoint = cfg.Pushgateway.Url,
                        Job = cfg.Pushgateway.Job,
                        IntervalMilliseconds = Math.Max(1, seconds) * 1000,
                    }).Start();
                    Log.Information($"Prometheus pushing to {cfg.Pushgateway.Url} (job '{cfg.Pushgateway.Job}') every {seconds}s.");
                }
                catch (Exception ex)
                {
                    Log.Error(ex, "Failed to start the Prometheus Pushgateway pusher.");
                }
            }
        }
    }

    // Per-instance metrics: every pod refreshes and serves its own /metrics (and pushes its own gauges), so
    protected override bool LeaderGated => false;

    protected override Task Execute(CancellationToken cancellationToken)
    {
        var labelNames = PrometheusLabels.Names(cfg);
        // The energy-flow tier feeding each reading — only built when the hierarchy label is wanted.
        var hierarchy = labelNames.Contains("hierarchy") ? BuildHierarchy() : null;

        // What each gauge was given this pass, so anything it held from a previous one can be dropped below.
        var written = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);

        foreach (var snapshot in FreshSnapshotsWithId())
            foreach (var r in MetricsHelper.EnumerateReadings(snapshot.Data))
            {
                var tier = hierarchy is null ? string.Empty : HierarchyFor(hierarchy, r);
                var values = PrometheusLabels.Values(labelNames, r, cfg, snapshot.InstanceId, tier);
                var name = MetricsHelper.PrometheusMetricName(r, cfg);
                GetGauge(name, labelNames, r).WithLabels(values).Set(r.Value);
                if (!written.TryGetValue(name, out var set)) written[name] = set = new(StringComparer.Ordinal);
                set.Add(LabelKey(values));
            }

        // An outlet that goes away — unplugged, renamed, a PDU dropped from the config — otherwise leaves its
        foreach (var (name, set) in written)
            if (gauges.TryGetValue(name, out var g))
                Prune(g, set);

        ExportFlowTiers();
        return Task.CompletedTask;
    }

    /// <summary>
    /// The energy-flow hierarchy as its own metric family: one series per tier, per metric.
    ///
    /// </summary>
    private void ExportFlowTiers()
    {
        try
        {
            var merged = new Models.PDU.PduData();
            foreach (var data in FreshSnapshots()) merged.Devices.AddRange(data.Devices);
            if (merged.Devices.Count == 0 && cfg.EnergyFlow.Nodes.Count == 0) return;

            var energyMetric = string.IsNullOrWhiteSpace(cfg.HASS.EnergyDashboard.EnergyMeasurementType)
                ? "energy" : cfg.HASS.EnergyDashboard.EnergyMeasurementType;

            // Power defines the topology (and therefore the tier labels); the other two are the same
            var power = Core.Flow.FlowGraphBuilder.Build(merged, cfg.EnergyFlow, Core.Flow.FlowGraphBuilder.DefaultMetric, live);
            var labels = power.Nodes.ToDictionary(n => n.Id, n => n, StringComparer.OrdinalIgnoreCase);

            foreach (var (metric, graph) in new[]
            {
                (Core.Flow.FlowGraphBuilder.DefaultMetric, power),
                (energyMetric, Core.Flow.FlowGraphBuilder.Build(merged, cfg.EnergyFlow, energyMetric, live)),
                (Core.Flow.EnergyPeriod.Metric, Core.Flow.FlowGraphBuilder.Build(merged, cfg.EnergyFlow, Core.Flow.EnergyPeriod.Metric, live)),
            })
            {
                var name = MetricsHelper.PrometheusMetricName($"flow_{metric}", "", "", graph.Units, cfg);
                var gauge = FlowGauge(name, metric, graph.Units);
                var written = new HashSet<string>(StringComparer.Ordinal);

                foreach (var node in graph.Nodes)
                {
                    // The unmetered remainder is arithmetic about a hierarchy, not a device, and does not
                    if (!Core.Flow.FlowExport.ToMetricsStore(node)) continue;
                    // Tag filter (#342): which nodes this scrape carries. Never changes a value.
                    if (!cfg.Prometheus.NodeTags.Allows(node.Tags)) continue;
                    // Unknown is not zero. A tier nothing determines must be absent from the scrape, so a
                    if (node.Value is not { } v) continue;

                    var tier = Core.Flow.FlowExport.Parents(power, node.Id).FirstOrDefault() ?? "";
                    var set = new[] { node.Id, node.Label, node.Kind, labels.TryGetValue(tier, out var p) ? p.Label : tier };
                    gauge.WithLabels(set).Set(v);
                    written.Add(LabelKey(set));
                }

                // Drop every label set we did NOT write this pass.
                Prune(gauge, written);
            }
        }
        catch (Exception ex) { Log.Debug($"Prometheus flow-tier export skipped: {ex.Message}"); }
    }

    private static readonly string[] FlowLabelNames = ["node", "name", "kind", "tier"];

    /// <summary>A label set as one comparable string. The separator is a unit separator, which cannot occur
    /// in a label value, so two different sets can never collide into one key.</summary>
    internal static string LabelKey(IReadOnlyList<string> labels) => string.Join('\u241F', labels);

    /// <summary>
    /// Forget every label set this gauge holds that was not written in the pass just finished.
    ///
    /// </summary>
    internal static void Prune(Collector<Gauge.Child> gauge, HashSet<string> written)
    {
        foreach (var stale in gauge.GetAllLabelValues().Where(l => !written.Contains(LabelKey(l))).ToList())
            gauge.RemoveLabelled(stale);
    }

    private Gauge FlowGauge(string name, string metric, string units)
    {
        if (!gauges.TryGetValue(name, out var gauge))
        {
            var friendly = MetricsHelper.FriendlyTypeName(metric);
            var u = string.IsNullOrWhiteSpace(units) ? "" : $" ({units})";
            gauge = Metrics.CreateGauge(name,
                $"{(string.IsNullOrWhiteSpace(friendly) ? metric : friendly)}{u} for an energy-flow tier, rolled up by rPDU2MQTT.",
                FlowLabelNames);
            gauges[name] = gauge;
        }
        return gauge;
    }

    /// <summary>Flow-node id -> the label of the tier feeding it, from the configured energy hierarchy.</summary>
    private Dictionary<string, string> BuildHierarchy()
    {
        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        try
        {
            var merged = new Models.PDU.PduData();
            foreach (var data in FreshSnapshots()) merged.Devices.AddRange(data.Devices);
            if (merged.Devices.Count == 0) return map;

            var graph = Core.Flow.FlowGraphBuilder.Build(merged, cfg.EnergyFlow, Core.Flow.FlowGraphBuilder.DefaultMetric, live);
            var labels = graph.Nodes.ToDictionary(n => n.Id, n => n.Label, StringComparer.OrdinalIgnoreCase);
            foreach (var node in graph.Nodes)
                if (Core.Flow.FlowExport.Parents(graph, node.Id).FirstOrDefault() is { } parent)
                    map[node.Id] = labels.TryGetValue(parent, out var l) ? l : parent;
        }
        catch (Exception ex) { Log.Debug($"Prometheus hierarchy label unavailable: {ex.Message}"); }
        return map;
    }

    private static string HierarchyFor(Dictionary<string, string> map, MeasurementReading r)
    {
        // Readings come from outlets (outlet:{device}:{key}) or device-level entities (pdu:{device}).
        if (r.Number is { } n && map.TryGetValue($"outlet:{r.Device}:{n - 1}", out var outletTier)) return outletTier;
        return map.TryGetValue($"pdu:{r.Device}", out var pduTier) ? pduTier : string.Empty;
    }

    // Cached by the resolved metric name (the template may vary the name by device/source/units).
    /// <summary>
    /// The gauge for a metric name, created on first use. Its HELP text is the measurement said in English
    /// with its unit (#206) — "Real Power (W), measured by rPDU2MQTT" — so a series is readable in Grafana's
    /// metric browser without knowing this project's vocabulary.
    /// </summary>
    private Gauge GetGauge(string name, string[] labelNames, MeasurementReading reading)
    {
        if (!gauges.TryGetValue(name, out var gauge))
        {
            var friendly = MetricsHelper.FriendlyTypeName(reading.Type);
            var units = string.IsNullOrWhiteSpace(reading.Units) ? "" : $" ({reading.Units})";
            var help = string.IsNullOrWhiteSpace(friendly)
                ? "Measured by rPDU2MQTT."
                : $"{friendly}{units}, measured by rPDU2MQTT.";

            gauge = Metrics.CreateGauge(name, help, labelNames);
            gauges[name] = gauge;
        }
        return gauge;
    }
}
