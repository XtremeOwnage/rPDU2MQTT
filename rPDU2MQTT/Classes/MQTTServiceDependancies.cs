using HiveMQtt.Client;

namespace rPDU2MQTT.Classes;

/// <summary>
/// Just a helper class, to reduce the constructor size when passing these dependanceies.
/// </summary>
public class MQTTServiceDependancies
{
    public MQTTServiceDependancies(IHiveMQClient mqtt, Config cfg, PDU pdu)
    {
        Mqtt = mqtt;
        Cfg = cfg;
        this.PDU = pdu;
    }

    public IHiveMQClient Mqtt { get; }
    public Config Cfg { get; }

    public PDU PDU { get; }
}
