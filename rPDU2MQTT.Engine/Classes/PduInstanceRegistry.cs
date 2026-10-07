using rPDU2MQTT.Models.Config;

namespace rPDU2MQTT.Classes;

/// <summary>The live <see cref="PDU"/> per configured instance with a host.</summary>
public sealed class PduInstanceRegistry
{
    private readonly PduInstanceFactory factory;
    private readonly object gate = new();
    private readonly Dictionary<string, PDU> instances = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>The DefaultInstanceKey entry, else the first built; null when none.</summary>
    public string? PrimaryId { get; private set; }

    public PduInstanceRegistry(Config config, PduInstanceFactory factory)
    {
        this.factory = factory;
        foreach (var (id, pduCfg) in config.Pdus)
            TryCreateInternal(id, pduCfg);

        if (instances.ContainsKey(Config.DefaultInstanceKey))
            PrimaryId = Config.DefaultInstanceKey;
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
        PrimaryId ??= id;
        return pdu;
    }

    /// <summary>A snapshot of every live instance (safe to iterate while reconciliation mutates the set).</summary>
    public IReadOnlyDictionary<string, PDU> All
    {
        get { lock (gate) return new Dictionary<string, PDU>(instances, StringComparer.OrdinalIgnoreCase); }
    }

    /// <summary>The primary instance's PDU, or null.</summary>
    public PDU? Primary { get { lock (gate) return PrimaryId is null ? null : instances[PrimaryId]; } }

    /// <summary>The instance, else the primary, else null.</summary>
    public PDU? Get(string instanceId)
    {
        lock (gate) return instances.TryGetValue(instanceId, out var p) ? p : PrimaryId is null ? null : instances[PrimaryId];
    }

    /// <summary>Build + register an instance at runtime (skips when hostless). Returns the PDU, or null if skipped.</summary>
    public PDU? TryCreate(string id, PduConfig pduCfg)
    {
        lock (gate) return TryCreateInternal(id, pduCfg);
    }

    /// <summary>Re-point the primary in place (#192). False when the new config has no host or there is no primary.</summary>
    public bool RepointPrimary(PduConfig pduCfg)
    {
        if (string.IsNullOrWhiteSpace(pduCfg.Connection?.Host))
        {
            Log.Warning($"Primary PDU instance '{PrimaryId}' has no Connection.Host; keeping the previous connection.");
            return false;
        }

        lock (gate)
        {
            if (PrimaryId is null) return false;
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
