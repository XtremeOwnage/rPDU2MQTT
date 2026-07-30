using HiveMQtt.MQTT5.Types;
using rPDU2MQTT.Classes;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// After an MQTT reconnect the broker keeps no session (the client id carries a fresh GUID), so every
/// subscription is dropped. A process worked at boot then went silently deaf days later, after the first
/// network blip — no outlet commands, no energy-flow values — until it was restarted.
///
/// The first fix replayed <c>client.Subscriptions</c> on reconnect and never worked, because HiveMQtt
/// <b>clears that list while reconnecting, before AfterConnect fires</b> (measured against 0.45.1: 2
/// subscriptions before the drop, 2 while down, 0 by the time the event ran). The old tests passed anyway:
/// they populated <c>Subscriptions</c> by hand, so they only ever proved that a list someone else filled
/// could be replayed. These use <see cref="FakeHiveMQClient.SimulateReconnect"/>, which clears the list the
/// way the real client does, so the assumption is part of the test rather than a silent precondition.
/// </summary>
[Collection("MqttSubscriptions")]
public class MqttResubscribeTests : IDisposable
{
    // The registry is process-wide; start each test from empty so ordering can't leak between them.
    public MqttResubscribeTests() => MqttSubscriptions.Reset();
    public void Dispose() => MqttSubscriptions.Reset();

    [Fact]
    public async Task Reconnect_ReestablishesSubscriptions_EvenThoughTheClientForgotThem()
    {
        var client = new FakeHiveMQClient();
        await MqttSubscriptions.SubscribeAsync(client, "rpdu2mqtt/+/outlets/+/set", QualityOfService.AtLeastOnceDelivery);
        await MqttSubscriptions.SubscribeAsync(client, "solar_assistant/inverter_1/grid_power/state", QualityOfService.AtLeastOnceDelivery);

        // The real reconnect: the client's own record is gone before anyone gets a chance to read it.
        client.SimulateReconnect();
        Assert.Empty(client.Subscriptions);

        await MqttSubscriptions.ResubscribeAllAsync(client);

        Assert.Contains("rpdu2mqtt/+/outlets/+/set", client.Subscribed);
        Assert.Contains("solar_assistant/inverter_1/grid_power/state", client.Subscribed);
    }

    [Fact]
    public async Task RepeatedReconnects_KeepRestoring_AndDontDoUnboundedWork()
    {
        var client = new FakeHiveMQClient();
        await MqttSubscriptions.SubscribeAsync(client, "a/b", QualityOfService.AtLeastOnceDelivery);

        for (var i = 0; i < 3; i++)
        {
            client.SimulateReconnect();
            await MqttSubscriptions.ResubscribeAllAsync(client);
            // Each reconnect restores the topic exactly once, however many times we've been round.
            Assert.Equal(new[] { "a/b" }, client.Subscribed);
        }
    }

    [Fact]
    public async Task AnUnsubscribedTopic_IsNotResurrectedByAReconnect()
    {
        var client = new FakeHiveMQClient();
        await MqttSubscriptions.SubscribeAsync(client, "keep/me", QualityOfService.AtLeastOnceDelivery);
        await MqttSubscriptions.SubscribeAsync(client, "drop/me", QualityOfService.AtLeastOnceDelivery);

        // Unbinding a flow node unsubscribes its topic; the registry has to hear about it.
        MqttSubscriptions.Forget("drop/me");

        client.SimulateReconnect();
        await MqttSubscriptions.ResubscribeAllAsync(client);

        Assert.Contains("keep/me", client.Subscribed);
        Assert.DoesNotContain("drop/me", client.Subscribed);
    }

    [Fact]
    public async Task FirstConnect_WithNothingSubscribed_IsANoOp()
    {
        var client = new FakeHiveMQClient();
        await MqttSubscriptions.ResubscribeAllAsync(client);
        Assert.Empty(client.Subscribed);
    }
}
