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
            instances[id] = factory.Create(pduCfg);
    }

    public IReadOnlyDictionary<string, PDU> All => instances;

    /// <summary>The primary instance's PDU (the DefaultInstanceKey entry, else the first).</summary>
    public PDU Primary =>
        instances.TryGetValue(Config.DefaultInstanceKey, out var p) ? p : instances.Values.First();

    public PDU Get(string instanceId) => instances.TryGetValue(instanceId, out var p) ? p : Primary;
}
