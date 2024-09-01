using Serilog.Events;

namespace rPDU2MQTT.Models.Config.Schemas;

public class LoggingTargetConfiguration
{
    public LogEventLevel Severity { get; set; } = LogEventLevel.Information;

    public string Format { get; set; } = "[{Timestamp:HH:mm:ss} {Level:u3}] {Message:lj}{NewLine}{Exception}";

    public bool Enabled { get; set; } = false;

}
