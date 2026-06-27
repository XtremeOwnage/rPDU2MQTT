using System.ComponentModel;

namespace rPDU2MQTT.Models.Config;

/// <summary>
/// Configuration for the read-only REST API (and its OpenAPI/Scalar docs), hosted on its own port and
/// independent of the GUI. Intended for monitoring/automation on a trusted network.
/// </summary>
public class ApiConfig
{
    [DefaultValue(false)]
    [Description("Expose a read-only REST API (/api/v1/*) with OpenAPI + Scalar docs on its own port. Place it on a trusted network — it is unauthenticated, like the health endpoints.")]
    public bool Enabled { get; set; } = false;

    [DefaultValue(8082)]
    [Description("Port the REST API + docs listen on.")]
    public int Port { get; set; } = 8082;

    [DefaultValue(null)]
    [Description("Optional API key enabling the write/control endpoints. When unset, the API is read-only; when set, control requests must send a matching 'X-Api-Key' header. Reads stay open (trusted-network).")]
    public string? ApiKey { get; set; } = null;
}
