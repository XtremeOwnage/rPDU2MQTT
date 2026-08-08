using System.Text.Json;

namespace rPDU2MQTT.Core.Flow;

/// <summary>
/// Where <see cref="PeriodCounterAudit"/>'s verdicts live between restarts.
///
/// <para>
/// The audit decides whether a source declared as a daily counter has behaved like one, and it can only
/// decide that by comparing a period against the one before it. Held in memory, a restart erases the
/// previous period: the source is unproven again and its reading is published as today's total until the
/// next rollover. On a deployment that restarts on every image update that is most of the time.
/// </para>
/// <para>
/// Keyed by node|source|direction, so it is a different shape from <see cref="IEnergyStore"/> and kept
/// apart from it. The two do sit side by side in the same backing store.
/// </para>
/// </summary>
public interface IPeriodAuditStore
{
    /// <summary>Everything known so far. Called once, before the first reading is judged.</summary>
    IReadOnlyDictionary<string, PeriodCounterAudit.State> Load();

    /// <summary>Persist the whole set. Called when a verdict or a high-water mark changes.</summary>
    void Save(IReadOnlyDictionary<string, PeriodCounterAudit.State> states);
}

/// <summary>Keeps the verdicts in memory only — the behaviour this interface exists to replace.</summary>
public sealed class MemoryPeriodAuditStore : IPeriodAuditStore
{
    private IReadOnlyDictionary<string, PeriodCounterAudit.State> held = new Dictionary<string, PeriodCounterAudit.State>();
    public IReadOnlyDictionary<string, PeriodCounterAudit.State> Load() => held;
    public void Save(IReadOnlyDictionary<string, PeriodCounterAudit.State> states) => held = states;
}

/// <summary>
/// One small JSON file, alongside the energy totals.
///
/// <para>
/// Written via a temp file and moved into place, so a crash mid-write leaves the previous verdicts rather
/// than a truncated file. A verdict lost this way is not silently wrong — it reverts to unproven, which is
/// the pre-restart behaviour.
/// </para>
/// </summary>
public sealed class FilePeriodAuditStore(string path, Action<string>? warn = null) : IPeriodAuditStore
{
    private static readonly JsonSerializerOptions Json = new() { WriteIndented = true };

    public IReadOnlyDictionary<string, PeriodCounterAudit.State> Load()
    {
        try
        {
            if (!File.Exists(path)) return new Dictionary<string, PeriodCounterAudit.State>();
            return JsonSerializer.Deserialize<Dictionary<string, PeriodCounterAudit.State>>(File.ReadAllText(path))
                   ?? new Dictionary<string, PeriodCounterAudit.State>();
        }
        catch (Exception ex)
        {
            warn?.Invoke($"Could not read the period-counter audit at {path} ({ex.Message}). Sources declared as "
                       + "daily counters are unproven until the next rollover.");
            return new Dictionary<string, PeriodCounterAudit.State>();
        }
    }

    public void Save(IReadOnlyDictionary<string, PeriodCounterAudit.State> states)
    {
        try
        {
            var tmp = path + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(states, Json));
            File.Move(tmp, path, overwrite: true);
        }
        catch (Exception ex)
        {
            warn?.Invoke($"Could not write the period-counter audit to {path} ({ex.Message}).");
        }
    }
}
