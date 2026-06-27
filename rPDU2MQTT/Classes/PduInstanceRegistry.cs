namespace rPDU2MQTT.Classes;

/// <summary>
/// Holds the live <see cref="PDU"/> per configured instance (built once at startup from Config.Pdus).
/// The pipeline polls every instance; GUI control/live/discovery use <see cref="Primary"/>.
/// </summary>
public sealed class PduInstanceRegistry
{
    private readonly Config config;
    private readonly Dictionary<string, PDU> instances = new(StringComparer.OrdinalIgnoreCase);

    public PduInstanceRegistry(Config config, PduInstanceFactory factory)
    {
        this.config = config;
        foreach (var (id, pduCfg) in config.Pdus)
        {
            // A half-configured instance (e.g. one just added in the GUI without a Host yet) must not
            // take down the whole bridge; skip it with a warning so the valid instances still run.
            if (string.IsNullOrWhiteSpace(pduCfg.Connection?.Host))
            {
                Log.Warning($"PDU instance '{id}' has no Connection.Host; skipping it. Set its host (or remove it) to enable polling.");
                continue;
            }
            instances[id] = factory.Create(pduCfg);
        }

        if (instances.Count == 0)
            throw new Exception("No usable PDU instances configured — every entry in 'Pdus' is missing Connection.Host. Set at least one PDU host.");
    }

    public IReadOnlyDictionary<string, PDU> All => instances;

    /// <summary>The primary instance's PDU (the DefaultInstanceKey entry, else the first).</summary>
    public PDU Primary =>
        instances.TryGetValue(Config.DefaultInstanceKey, out var p) ? p : instances.Values.First();

    public PDU Get(string instanceId) => instances.TryGetValue(instanceId, out var p) ? p : Primary;
}
