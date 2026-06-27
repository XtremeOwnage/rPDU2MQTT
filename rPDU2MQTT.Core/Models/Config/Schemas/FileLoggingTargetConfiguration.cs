namespace rPDU2MQTT.Models.Config.Schemas;

public class FileLoggingTargetConfiguration : LoggingTargetConfiguration
{
    /// <summary>
    /// Path to log file which will be used.
    /// </summary>
    public string? Path { get; set; } = null;

    /// <summary>
    /// This determines when files are rolled over.
    /// </summary>
    public RollingInterval FileRollover { get; set; } = RollingInterval.Day;

    /// <summary>
    /// This determines how many rolled over files to retain.
    /// </summary>
    public int FileRetention { get; set; } = 30;
}
