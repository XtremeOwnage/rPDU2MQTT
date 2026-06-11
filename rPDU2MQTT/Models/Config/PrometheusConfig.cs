using System.ComponentModel;

namespace rPDU2MQTT.Models.Config;

/// <summary>
/// Configuration for the Prometheus metrics exporter.
/// </summary>
public class PrometheusConfig
{
    [DefaultValue(false)]
    public bool Enabled { get; set; }

    /// <summary>Port the /metrics endpoint listens on.</summary>
    [DefaultValue(9184)]
    public int Port { get; set; } = 9184;
}
