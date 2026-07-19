namespace rPDU2MQTT.Services;

/// <summary>
/// Tracks the outcome of the most recent EmonCMS export so the GUI can show a health indicator.
/// Thread-safe; a singleton shared by <see cref="EmonCmsExportService"/> (writer) and the GUI (reader).
/// </summary>
public sealed class EmonCmsStatus
{
    private readonly object gate = new();

    public DateTime? LastAttemptUtc { get; private set; }
    public DateTime? LastSuccessUtc { get; private set; }
    public bool? LastOk { get; private set; }
    public string? LastError { get; private set; }
    public int LastCount { get; private set; }

    public void RecordSuccess(int count)
    {
        lock (gate)
        {
            var now = DateTime.UtcNow;
            LastAttemptUtc = now;
            LastSuccessUtc = now;
            LastOk = true;
            LastError = null;
            LastCount = count;
        }
    }

    public void RecordFailure(string error)
    {
        lock (gate)
        {
            LastAttemptUtc = DateTime.UtcNow;
            LastOk = false;
            LastError = error;
        }
    }

    /// <summary>True once this process has actually tried an export — i.e. it runs the exporter (the worker).</summary>
    public bool HasAttempted { get { lock (gate) return LastAttemptUtc is not null; } }

    /// <summary>A snapshot for serialization (e.g. the diagnostics endpoint) and for the heartbeat.</summary>
    public Core.EmonCmsHealth Snapshot()
    {
        lock (gate)
            return new Core.EmonCmsHealth(LastOk, LastAttemptUtc, LastSuccessUtc, LastError, LastCount);
    }
}
