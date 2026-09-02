namespace rPDU2MQTT.Core.Flow;

/// <summary>
/// Where accumulated energy lives between samples — and, crucially, across restarts.
///
/// <para>
/// Energy is a cumulative counter. Home Assistant and EmonCMS treat a drop as a meter reset and correct
/// their history for it, so losing the running total on every restart doesn't just lose data, it corrupts
/// what was already recorded. That is why the default keeps a file rather than staying in memory.
/// </para>
/// <para>
/// An interface because the right answer differs by deployment: a file for the single-process case (the
/// default — no service to run), and, for several replicas sharing one accumulator, a shared store such
/// as redis slotting in here without touching the integration logic.
/// </para>
/// </summary>
public interface IEnergyStore
{
    /// <summary>Everything known so far, keyed by node id. Called once at startup.</summary>
    IReadOnlyDictionary<string, EnergyState> Load();

    /// <summary>Persist the whole set. Called after a sampling pass; implementations may debounce.</summary>
    void Save(IReadOnlyDictionary<string, EnergyState> states);

    /// <summary>
    /// The highest figure already published for each export key — the high-water marks
    /// <see cref="CumulativeExport"/> uses to keep a <c>total_increasing</c> sensor from going backwards.
    ///
    /// <para>
    /// These have to outlive the process. The guard held them in memory only, so every restart re-baselined
    /// it: the next pass published whatever the raw counter happened to read, and where that was below what
    /// had already gone out, Home Assistant recorded a meter reset and re-counted the whole climb. On a
    /// bridge that restarted seventeen times in a week, that turned a house using tens of kWh a day into
    /// megawatt-hours.
    /// </para>
    /// <para>
    /// Defaulted so a store that deliberately keeps nothing — the in-memory one — is unaffected.
    /// </para>
    /// </summary>
    IReadOnlyDictionary<string, double> LoadPeaks() => new Dictionary<string, double>();

    /// <summary>Persist the high-water marks. Called when one of them moves.</summary>
    void SavePeaks(IReadOnlyDictionary<string, double> peaks) { }
}

/// <summary>Keeps the totals in memory only. Deliberately loses them on restart — see <see cref="IEnergyStore"/>.</summary>
public sealed class MemoryEnergyStore : IEnergyStore
{
    private IReadOnlyDictionary<string, EnergyState> held = new Dictionary<string, EnergyState>();
    public IReadOnlyDictionary<string, EnergyState> Load() => held;
    public void Save(IReadOnlyDictionary<string, EnergyState> states) => held = states;
}
