using rPDU2MQTT.Models.Config;

namespace rPDU2MQTT.Classes;

/// <summary>
/// Holds the live <see cref="PDU"/> per configured instance. Built from <see cref="Config.Pdus"/> at
/// startup; <see cref="TryCreate"/>/<see cref="Remove"/> let the <see cref="Services.InstanceManager"/>
/// add/remove instances at runtime (phase 5). The pipeline polls every instance; GUI control/live/
/// discovery use <see cref="Primary"/>.
/// </summary>
/// <remarks>
/// <see cref="Primary"/>'s PDU <i>object</i> is fixed for the process lifetime — it's the DI-resolved
/// <see cref="PDU"/> shared with the GUI / control / discovery, so reconciliation never swaps it. A
/// changed primary is applied by <see cref="RepointPrimary"/>, which mutates that object in place instead
/// (#192). Reads/writes are guarded so reconciliation can run while the GUI reads.
/// </remarks>
public sealed class PduInstanceRegistry
{
    private readonly PduInstanceFactory factory;
    private readonly object gate = new();
    private readonly Dictionary<string, PDU> instances = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>The fixed primary instance id (the DefaultInstanceKey entry, else the first at startup).</summary>
    public string PrimaryId { get; }

    public PduInstanceRegistry(Config config, PduInstanceFactory factory)
    {
        this.factory = factory;
        foreach (var (id, pduCfg) in config.Pdus)
            TryCreateInternal(id, pduCfg);

        if (instances.Count == 0)
            throw new Exception("No usable PDU instances configured — every entry in 'Pdus' is missing Connection.Host. Set at least one PDU host.");

        PrimaryId = instances.ContainsKey(Config.DefaultInstanceKey) ? Config.DefaultInstanceKey : instances.Keys.First();
    }

    // Build + register an instance; skips (returns null) when it has no Host. Not locked — callers do.
    private PDU? TryCreateInternal(string id, PduConfig pduCfg)
    {
        if (string.IsNullOrWhiteSpace(pduCfg.Connection?.Host))
        {
            Log.Warning($"PDU instance '{id}' has no Connection.Host; skipping it. Set its host (or remove it) to enable polling.");
            return null;
        }
        var pdu = factory.Create(pduCfg);
        instances[id] = pdu;
        return pdu;
    }

    /// <summary>A snapshot of every live instance (safe to iterate while reconciliation mutates the set).</summary>
    public IReadOnlyDictionary<string, PDU> All
    {
        get { lock (gate) return new Dictionary<string, PDU>(instances, StringComparer.OrdinalIgnoreCase); }
    }

    /// <summary>The primary instance's PDU (the same object for the process lifetime; see RepointPrimary).</summary>
    public PDU Primary { get { lock (gate) return instances[PrimaryId]; } }

    public PDU Get(string instanceId)
    {
        lock (gate) return instances.TryGetValue(instanceId, out var p) ? p : instances[PrimaryId];
    }

    /// <summary>Build + register an instance at runtime (skips when hostless). Returns the PDU, or null if skipped.</summary>
    public PDU? TryCreate(string id, PduConfig pduCfg)
    {
        lock (gate) return TryCreateInternal(id, pduCfg);
    }

    /// <summary>
    /// Re-point the primary at a new configuration (#192). The primary's PDU object can't be replaced —
    /// it's the DI singleton — so it's mutated in place instead, which keeps every existing reference
    /// valid. Returns false (leaving the instance untouched) when the new config has no Host to point at.
    /// </summary>
    public bool RepointPrimary(PduConfig pduCfg)
    {
        if (string.IsNullOrWhiteSpace(pduCfg.Connection?.Host))
        {
            Log.Warning($"Primary PDU instance '{PrimaryId}' has no Connection.Host; keeping the previous connection.");
            return false;
        }

        lock (gate)
        {
            factory.Repoint(instances[PrimaryId], pduCfg);
            return true;
        }
    }

    /// <summary>Remove an instance at runtime. Never removes the primary. Returns true if it was removed.</summary>
    public bool Remove(string id)
    {
        if (string.Equals(id, PrimaryId, StringComparison.OrdinalIgnoreCase))
            return false;
        lock (gate) return instances.Remove(id);
    }
}
