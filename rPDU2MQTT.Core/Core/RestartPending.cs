namespace rPDU2MQTT.Core;

/// <summary>
/// The settings that have been saved but are not what this process is running.
///
/// </summary>
public sealed class RestartPending
{
    private readonly Lock gate = new();
    private string[] settings = [];

    /// <summary>Replace the set with what the latest save could not apply.</summary>
    public void Set(IEnumerable<string> paths)
    {
        lock (gate) settings = paths.Distinct(StringComparer.Ordinal).OrderBy(p => p, StringComparer.Ordinal).ToArray();
    }

    /// <summary>The saved settings this process is not running.</summary>
    public IReadOnlyList<string> Settings { get { lock (gate) return settings; } }

    public bool Required { get { lock (gate) return settings.Length > 0; } }
}
