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
    // this is NOT run-once cluster-wide — don't leader-gate it.
    protected override bool LeaderGated => false;

    protected override Task Execute(CancellationToken cancellationToken)
    {
        var labelNames = PrometheusLabels.Names(cfg);
        // The energy-flow tier feeding each reading — only built when the hierarchy label is wanted.
        var hierarchy = labelNames.Contains("hierarchy") ? BuildHierarchy() : null;

        foreach (var snapshot in FreshSnapshotsWithId())
            foreach (var r in MetricsHelper.EnumerateReadings(snapshot.Data))
            {
                var tier = hierarchy is null ? string.Empty : HierarchyFor(hierarchy, r);
                var values = PrometheusLabels.Values(labelNames, r, cfg, snapshot.InstanceId, tier);
                GetGauge(MetricsHelper.PrometheusMetricName(r, cfg), labelNames).WithLabels(values).Set(r.Value);
            }

        return Task.CompletedTask;
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
    private Gauge GetGauge(string name, string[] labelNames)
    {
        if (!gauges.TryGetValue(name, out var gauge))
        {
            gauge = Metrics.CreateGauge(name, "rPDU2MQTT measurement", labelNames);
            gauges[name] = gauge;
        }
        return gauge;
    }
}
