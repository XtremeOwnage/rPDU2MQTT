namespace rPDU2MQTT.Models.Config.Schemas;

public enum SyslogProtocol
{
    UDP,
    TCP,
}

/// <summary>
/// Configuration for sending logs to a remote syslog server.
/// </summary>
public class SyslogLoggingTargetConfiguration : LoggingTargetConfiguration
{
    /// <summary>Hostname or IP of the syslog server.</summary>
    public string? Host { get; set; }

    /// <summary>Syslog server port (default 514).</summary>
    public int Port { get; set; } = 514;

    /// <summary>Transport protocol (UDP or TCP).</summary>
    public SyslogProtocol Protocol { get; set; } = SyslogProtocol.UDP;

    /// <summary>Application name reported in the syslog messages.</summary>
    public string AppName { get; set; } = "rPDU2MQTT";
}
