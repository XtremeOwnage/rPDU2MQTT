namespace rPDU2MQTT.Core;

/// <summary>
/// The settings that have been saved but are not what this process is running.
///
/// <para>
/// Process state on purpose: it describes the gap between the configuration on disk and the configuration
/// in memory, and a restart is exactly what closes that gap — so the state disappearing on restart is the
/// correct behaviour, not a limitation.
/// </para>
/// <para>
/// Held here rather than mentioned once in the toast that follows a save. A message you can miss (or that
/// another browser never saw) leaves the GUI showing values the bridge is not using, with nothing on screen
/// saying so.
/// </para>
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
