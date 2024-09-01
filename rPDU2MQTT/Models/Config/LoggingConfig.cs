using rPDU2MQTT.Models.Config.Schemas;
using Serilog.Events;
using YamlDotNet.Serialization;

namespace rPDU2MQTT.Models.Config;

/// <summary>
/// Configuration for logging.
/// </summary>
public class LoggingConfig
{
    public string? LogFilePath { get; set; } = null;

    [YamlMember(Alias = "Console")]
    public LoggingTargetConfiguration Console { get; set; } = new LoggingTargetConfiguration()
    {
        Enabled = true,
        Severity = LogEventLevel.Information,
    };

    [YamlMember(Alias = "File")]
    public LoggingTargetConfiguration File { get; set; } = new LoggingTargetConfiguration()
    {
        Enabled = false,
        Severity = LogEventLevel.Debug
    };
}