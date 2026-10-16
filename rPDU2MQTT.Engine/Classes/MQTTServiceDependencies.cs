using HiveMQtt.Client;
using rPDU2MQTT.Core;

namespace rPDU2MQTT.Classes;

/// <summary>Shared dependencies for MQTT services.</summary>
public class MQTTServiceDependencies
{
    public MQTTServiceDependencies(IHiveMQClient mqtt, Config cfg, Core.Integrations.IPduInstances pdus, ISnapshotCache snapshotCache, LeaderState? leader = null)
    {
        Mqtt = mqtt;
        Cfg = cfg;
        this.pdus = pdus;
        SnapshotCache = snapshotCache;
        Leader = leader;
    }

    public IHiveMQClient Mqtt { get; }
    public Config Cfg { get; }

    private readonly Core.Integrations.IPduInstances pdus;

    /// <summary>The primary PDU, or null when none is configured.</summary>
    public Core.Integrations.IPduInstance? PDU => pdus.Primary;

    /// <summary>Latest pipeline snapshot per source (the PduPoller produces; consumers read).</summary>
    public ISnapshotCache SnapshotCache { get; }

    /// <summary>v3 cluster-leadership flag; run-once exporters self-gate on it. Null in tests → treated as leader.</summary>
    public LeaderState? Leader { get; }
}
