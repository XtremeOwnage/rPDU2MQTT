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
}

/// <summary>Keeps the totals in memory only. Deliberately loses them on restart — see <see cref="IEnergyStore"/>.</summary>
public sealed class MemoryEnergyStore : IEnergyStore
{
    private IReadOnlyDictionary<string, EnergyState> held = new Dictionary<string, EnergyState>();
    public IReadOnlyDictionary<string, EnergyState> Load() => held;
    public void Save(IReadOnlyDictionary<string, EnergyState> states) => held = states;
}
