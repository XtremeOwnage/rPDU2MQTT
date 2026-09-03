using System.Text.Json;

namespace rPDU2MQTT.Core.Flow;

/// <summary>
/// The default store: one small JSON file.
///
/// <para>
/// A file rather than a database because the data is a handful of rows — one per node — and a database
/// would mean either a new service in everyone's deployment or a native dependency, for no benefit at
/// this size. JSON rather than a binary format because a corrupted counter is something an operator may
/// well want to inspect or hand-correct.
/// </para>
/// <para>
/// Writes go to a temp file and are then moved into place, so a crash mid-write leaves the previous total
/// intact instead of a truncated file. Losing the counter is the failure that corrupts downstream history.
/// </para>
/// </summary>
public sealed class FileEnergyStore : IEnergyStore
{
    private static readonly JsonSerializerOptions Json = new() { WriteIndented = true };
    private readonly string path;
    private readonly Action<string>? warn;

    public FileEnergyStore(string path, Action<string>? warn = null)
    {
        this.path = path;
        this.warn = warn;
    }

    public IReadOnlyDictionary<string, EnergyState> Load()
    {
        try
        {
            if (!File.Exists(path))
                return new Dictionary<string, EnergyState>();
            var json = File.ReadAllText(path);
            return JsonSerializer.Deserialize<Dictionary<string, EnergyState>>(json, Json)
                   ?? new Dictionary<string, EnergyState>();
        }
        catch (Exception ex)
        {
            // Starting from zero silently would look like a meter reset downstream; say so loudly, because
            // the totals in that file are not reconstructible from anything else.
            warn?.Invoke($"Could not read the energy totals at {path} ({ex.Message}). Accumulation restarts from zero, "
                       + "which downstream consumers will read as a meter reset.");
            return new Dictionary<string, EnergyState>();
        }
    }

    public void Save(IReadOnlyDictionary<string, EnergyState> states)
    {
        try
        {
            var dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            var tmp = path + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(states, Json));
            File.Move(tmp, path, overwrite: true);   // atomic on every platform we target
        }
        catch (Exception ex)
        {
            warn?.Invoke($"Could not write the energy totals to {path} ({ex.Message}). They are still being "
                       + "accumulated in memory, but a restart will lose them.");
        }
    }
    /// <summary>The high-water marks, in a file beside the totals — they have to survive a restart.</summary>
    public IReadOnlyDictionary<string, double> LoadPeaks()
    {
        try
        {
            return File.Exists(PeaksPath)
                ? JsonSerializer.Deserialize<Dictionary<string, double>>(File.ReadAllText(PeaksPath))
                  ?? new Dictionary<string, double>()
                : new Dictionary<string, double>();
        }
        catch (Exception ex)
        {
            warn?.Invoke($"Could not read the published high-water marks from {PeaksPath} ({ex.Message}). "
                       + "They start empty, so a counter now reading below what was already published would be "
                       + "read downstream as a meter reset.");
            return new Dictionary<string, double>();
        }
    }

    public void SavePeak(string key, double value)
    {
        // A file has no per-field write, so the merge happens here: read what is on disk, change the one
        // mark, put it back. Never write only the mark that moved — that would drop every other one.
        try
        {
            var all = new Dictionary<string, double>(LoadPeaks()) { [key] = value };
            File.WriteAllText(PeaksPath, JsonSerializer.Serialize(all));
        }
        catch (Exception ex) { warn?.Invoke($"Could not write the high-water mark for '{key}' to {PeaksPath} ({ex.Message})."); }
    }

    private string PeaksPath => Path.Combine(Path.GetDirectoryName(path) ?? ".",
        Path.GetFileNameWithoutExtension(path) + "-peaks.json");
}
