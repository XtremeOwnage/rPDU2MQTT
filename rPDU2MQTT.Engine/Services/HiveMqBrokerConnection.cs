using HiveMQtt.Client;
using rPDU2MQTT.Core.Integrations;

namespace rPDU2MQTT.Services;

/// <summary>
/// <see cref="IBrokerConnection"/> over the shared HiveMQ client. The one place that knows which MQTT
/// library this build uses, alongside <see cref="MqttMessagePublisher"/>.
/// </summary>
public sealed class HiveMqBrokerConnection : IBrokerConnection
{
    private readonly IHiveMQClient mqtt;

    public HiveMqBrokerConnection(IHiveMQClient mqtt) => this.mqtt = mqtt;

    public bool Connected => mqtt.IsConnected();

    public string Endpoint => $"{mqtt.Options.Host}:{mqtt.Options.Port}";
}
