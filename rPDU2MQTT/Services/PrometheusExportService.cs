using Prometheus;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Helpers;
using rPDU2MQTT.Services.baseTypes;

namespace rPDU2MQTT.Services;

/// <summary>
/// Exposes PDU measurements as Prometheus metrics on a /metrics endpoint. Each measurement type
/// becomes a gauge (e.g. rpdu2mqtt_realpower) labelled by device and source. Enabled via config.
/// </summary>
public class PrometheusExportService : baseMQTTService
{
    private readonly Dictionary<string, Gauge> gauges = new();
    private readonly IMetricServer? server;

    public PrometheusExportService(MQTTServiceDependencies deps) : base(deps, deps.Cfg.PDU.PollInterval)
    {
        var port = deps.Cfg.Prometheus.Port;
        try
        {
            server = new MetricServer(port: port).Start();
            Log.Information($"Prometheus exporter listening on :{port}/metrics");
        }
        catch (Exception ex)
        {
            Log.Error(ex, $"Failed to start the Prometheus metric server on port {port}.");
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
