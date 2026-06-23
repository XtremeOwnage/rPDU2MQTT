using HiveMQtt.Client;
using rPDU2MQTT.Core;

namespace rPDU2MQTT.Classes;

/// <summary>
/// Just a helper class, to reduce the constructor size when passing these dependencies.
/// </summary>
public class MQTTServiceDependencies
{
    public MQTTServiceDependencies(IHiveMQClient mqtt, Config cfg, PDU pdu, ISnapshotCache snapshotCache)
    {
        Mqtt = mqtt;
        Cfg = cfg;
        this.PDU = pdu;
        SnapshotCache = snapshotCache;
    }

    public IHiveMQClient Mqtt { get; }
    public Config Cfg { get; }

    public PDU PDU { get; }

    /// <summary>Latest pipeline snapshot per source (the PduPoller produces; consumers read).</summary>
    public ISnapshotCache SnapshotCache { get; }
}
