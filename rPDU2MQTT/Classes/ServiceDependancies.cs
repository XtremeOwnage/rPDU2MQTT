using HiveMQtt.Client;

namespace rPDU2MQTT.Classes;

public class ServiceDependancies
{
    public ServiceDependancies(IHiveMQClient mqtt, Config cfg, PDU pdu)
    {
        Mqtt = mqtt;
        Cfg = cfg;
        this.PDU = pdu;
    }

    public IHiveMQClient Mqtt { get; }
    public Config Cfg { get; }

    public PDU PDU { get; }
}
