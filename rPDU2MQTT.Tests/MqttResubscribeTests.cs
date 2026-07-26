using HiveMQtt.MQTT5.Types;
using rPDU2MQTT.Classes;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// After an MQTT reconnect the broker keeps no session (the client id carries a fresh GUID), so every
/// subscription is dropped. Nothing re-added them — a process worked at boot then went silently deaf days
/// later, after the first network blip. This restores them on reconnect.
/// </summary>
public class MqttResubscribeTests
{
    private static Subscription Sub(string topic, QualityOfService qos = QualityOfService.AtLeastOnceDelivery)
        => new(new TopicFilter(topic, qos));

    [Fact]
    public async Task Reconnect_ReestablishesEveryTrackedSubscription()
    {
        var client = new FakeHiveMQClient();
        client.Subscriptions.Add(Sub("rpdu2mqtt/+/outlets/+/set"));
        client.Subscriptions.Add(Sub("solar_assistant/inverter_1/grid_power/state"));

        await MqttSubscriptions.ResubscribeAllAsync(client);

        Assert.Contains("rpdu2mqtt/+/outlets/+/set", client.Subscribed);
        Assert.Contains("solar_assistant/inverter_1/grid_power/state", client.Subscribed);
    }

    [Fact]
    public async Task RepeatedReconnects_DontDoUnboundedWork()
    {
        var client = new FakeHiveMQClient();
        // The real client appends to its subscription list on each SubscribeAsync, so after a few reconnects
        // the list holds duplicates. We must re-subscribe each distinct topic once, not once per duplicate.
        client.Subscriptions.Add(Sub("a/b"));
        client.Subscriptions.Add(Sub("a/b"));
        client.Subscriptions.Add(Sub("a/b"));

        await MqttSubscriptions.ResubscribeAllAsync(client);

        Assert.Single(client.Subscribed);
        Assert.Equal("a/b", client.Subscribed[0]);
    }

    [Fact]
    public async Task FirstConnect_WithNoSubscriptions_IsANoOp()
    {
        var client = new FakeHiveMQClient();
        await MqttSubscriptions.ResubscribeAllAsync(client);
        Assert.Empty(client.Subscribed);
    }
}
