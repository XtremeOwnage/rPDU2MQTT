using System.ComponentModel;

namespace rPDU2MQTT.Models.Config;

/// <summary>
/// Configuration for the HTTP health-check endpoints (liveness/readiness) used by container probes.
/// </summary>
public class HealthConfig
{
    [DefaultValue(true)]
    [Description("Expose HTTP health-check endpoints: /healthz (liveness) and /readyz (readiness).")]
    public bool Enabled { get; set; } = true;

    [DefaultValue(8081)]
    [Description("Port the health-check endpoints listen on.")]
    public int Port { get; set; } = 8081;
}
