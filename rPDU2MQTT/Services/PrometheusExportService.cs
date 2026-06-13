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

    public PrometheusExportService(MQTTServiceDependencies deps) : base(deps, deps.Cfg.PDU.PollInterval)
    {
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
                    var seconds = cfg.Pushgateway.IntervalSeconds > 0 ? cfg.Pushgateway.IntervalSeconds : deps.Cfg.PDU.PollInterval;
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

    protected override async Task Execute(CancellationToken cancellationToken)
    {
        var data = await pdu.GetRootData_Public(cancellationToken);

        foreach (var r in MetricsHelper.EnumerateReadings(data))
            GetGauge(r.Type).WithLabels(r.Device, r.Source, r.Units).Set(r.Value);
    }

    private Gauge GetGauge(string type)
    {
        if (!gauges.TryGetValue(type, out var gauge))
        {
            gauge = Metrics.CreateGauge($"rpdu2mqtt_{Sanitize(type)}", $"rPDU2MQTT {type} measurement", "device", "source", "units");
            gauges[type] = gauge;
        }
        return gauge;
    }

    private static string Sanitize(string value)
        => new(value.Select(c => char.IsLetterOrDigit(c) ? char.ToLowerInvariant(c) : '_').ToArray());
}
