using HiveMQtt.Client;
using HiveMQtt.MQTT5.Types;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Integrations;

namespace rPDU2MQTT.Services;

/// <summary>
/// <see cref="IMessagePublisher"/> over the shared HiveMQ client — the publish half of
/// <c>baseMQTTService</c>, without the hosting model attached to it.
/// </summary>
public sealed class MqttMessagePublisher : IMessagePublisher
{
    private readonly IHiveMQClient mqtt;
    private readonly Config cfg;

    public MqttMessagePublisher(IHiveMQClient mqtt, Config cfg)
    {
        this.mqtt = mqtt;
        this.cfg = cfg;
    }

    public Task PublishAsync(string topic, string payload, bool retain, CancellationToken ct, DateTime? timestampUtc = null)
    {
        // The global "don't actually publish" switch, honoured in one place rather than by every caller.
        if (!cfg.Debug.PublishMessages) return Task.CompletedTask;

        var msg = new MQTT5PublishMessage(topic, QualityOfService.AtLeastOnceDelivery)
        {
            PayloadAsString = payload,
            Retain = retain,
        };

        // The moment the data was read, not the moment it was published — invisible to consumers that
        // don't look for it, and the only thing that distinguishes a stale republish from a fresh reading.
        if (cfg.MQTT.MessageTimestamp == Models.Config.MessageTimestampMode.UserProperty)
            msg.UserProperties[Core.MessageTimestamps.PropertyName] =
                Core.MessageTimestamps.Format(timestampUtc ?? DateTime.UtcNow);

        // Bounded wait, never a cancelled publish — see Core.PublishTimeout for why that distinction matters.
        var seconds = cfg.MQTT.PublishTimeoutSeconds is > 0 and <= 600 ? cfg.MQTT.PublishTimeoutSeconds : 15;
        return Core.PublishTimeout.RunAsync(
            () => mqtt.PublishAsync(msg, ct), TimeSpan.FromSeconds(seconds), topic, ct);
    }
}
