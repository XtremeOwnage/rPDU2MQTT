using HiveMQtt.Client;
using HiveMQtt.Client.Options;
using HiveMQtt.Client.Results;
using HiveMQtt.MQTT5.Types;

namespace rPDU2MQTT.Tests;

/// <summary>
/// A stand-in IHiveMQClient that records the re-point sequence, so MqttReconfigurator can be tested
/// without a live broker (#192). Only the members the reconfigurator touches do anything.
/// </summary>
internal sealed class FakeHiveMQClient : IHiveMQClient
{
    public List<string> Calls { get; } = new();
    public List<string> Subscribed { get; } = new();
    public bool Connected { get; set; } = true;
    public HiveMQClientOptions? OptionsWhenConnected { get; private set; }

    public HiveMQClientOptions Options { get; set; } = new();
    public List<Subscription> Subscriptions { get; } = new();
    public Dictionary<string, string> LocalStore { get; } = new();

    public bool IsConnected() => Connected;

    public Task<ConnectResult> ConnectAsync(ConnectOptions? connectOptions = default)
    {
        Calls.Add("connect");
        Connected = true;
        // Capture what the options were AT connect time, to prove the swap happened before connecting.
        OptionsWhenConnected = Options;
        return Task.FromResult<ConnectResult>(null!);
    }

    public Task<bool> DisconnectAsync(DisconnectOptions? options = default)
    {
        Calls.Add("disconnect");
        Connected = false;
        return Task.FromResult(true);
    }

    public Task<SubscribeResult> SubscribeAsync(string topic, QualityOfService qos = default, bool noLocal = default, bool retainAsPublished = default, RetainHandling retainHandling = default)
    {
        Calls.Add("subscribe:" + topic);
        Subscribed.Add(topic);
        return Task.FromResult<SubscribeResult>(null!);
    }

    public Task<SubscribeResult> SubscribeAsync(SubscribeOptions options) => throw new NotImplementedException();
    public Task<PublishResult> PublishAsync(MQTT5PublishMessage message, CancellationToken cancellationToken = default) => throw new NotImplementedException();
    public Task<PublishResult> PublishAsync(string topic, string payload, QualityOfService qos = default) => throw new NotImplementedException();
    public Task<PublishResult> PublishAsync(string topic, byte[] payload, QualityOfService qos = default) => throw new NotImplementedException();
    public Task<UnsubscribeResult> UnsubscribeAsync(string topic) => throw new NotImplementedException();
    public Task<UnsubscribeResult> UnsubscribeAsync(Subscription subscription) => throw new NotImplementedException();
    public Task<UnsubscribeResult> UnsubscribeAsync(List<Subscription> subscriptions) => throw new NotImplementedException();
    public Task AckAsync(ushort packetIdentifier) => throw new NotImplementedException();
    public Task AckAsync(HiveMQtt.Client.Events.OnMessageReceivedEventArgs eventArgs) => throw new NotImplementedException();
    public void Dispose() { }

    public event System.EventHandler<HiveMQtt.Client.Events.BeforeConnectEventArgs>? BeforeConnect { add { } remove { } }
    public event System.EventHandler<HiveMQtt.Client.Events.AfterConnectEventArgs>? AfterConnect { add { } remove { } }
    public event System.EventHandler<HiveMQtt.Client.Events.BeforeDisconnectEventArgs>? BeforeDisconnect { add { } remove { } }
    public event System.EventHandler<HiveMQtt.Client.Events.AfterDisconnectEventArgs>? AfterDisconnect { add { } remove { } }
    public event System.EventHandler<HiveMQtt.Client.Events.BeforeSubscribeEventArgs>? BeforeSubscribe { add { } remove { } }
    public event System.EventHandler<HiveMQtt.Client.Events.AfterSubscribeEventArgs>? AfterSubscribe { add { } remove { } }
    public event System.EventHandler<HiveMQtt.Client.Events.BeforeUnsubscribeEventArgs>? BeforeUnsubscribe { add { } remove { } }
    public event System.EventHandler<HiveMQtt.Client.Events.AfterUnsubscribeEventArgs>? AfterUnsubscribe { add { } remove { } }
    public event System.EventHandler<HiveMQtt.Client.Events.OnMessageReceivedEventArgs>? OnMessageReceived { add { } remove { } }
    public event System.EventHandler<HiveMQtt.Client.Events.OnConnectSentEventArgs>? OnConnectSent { add { } remove { } }
    public event System.EventHandler<HiveMQtt.Client.Events.OnConnAckReceivedEventArgs>? OnConnAckReceived { add { } remove { } }
    public event System.EventHandler<HiveMQtt.Client.Events.OnDisconnectSentEventArgs>? OnDisconnectSent { add { } remove { } }
    public event System.EventHandler<HiveMQtt.Client.Events.OnDisconnectReceivedEventArgs>? OnDisconnectReceived { add { } remove { } }
    public event System.EventHandler<HiveMQtt.Client.Events.OnPingReqSentEventArgs>? OnPingReqSent { add { } remove { } }
    public event System.EventHandler<HiveMQtt.Client.Events.OnPingRespReceivedEventArgs>? OnPingRespReceived { add { } remove { } }
    public event System.EventHandler<HiveMQtt.Client.Events.OnSubscribeSentEventArgs>? OnSubscribeSent { add { } remove { } }
    public event System.EventHandler<HiveMQtt.Client.Events.OnSubAckReceivedEventArgs>? OnSubAckReceived { add { } remove { } }
    public event System.EventHandler<HiveMQtt.Client.Events.OnUnsubscribeSentEventArgs>? OnUnsubscribeSent { add { } remove { } }
    public event System.EventHandler<HiveMQtt.Client.Events.OnUnsubAckReceivedEventArgs>? OnUnsubAckReceived { add { } remove { } }
    public event System.EventHandler<HiveMQtt.Client.Events.OnPublishReceivedEventArgs>? OnPublishReceived { add { } remove { } }
    public event System.EventHandler<HiveMQtt.Client.Events.OnPublishSentEventArgs>? OnPublishSent { add { } remove { } }
    public event System.EventHandler<HiveMQtt.Client.Events.OnPubAckReceivedEventArgs>? OnPubAckReceived { add { } remove { } }
    public event System.EventHandler<HiveMQtt.Client.Events.OnPubAckSentEventArgs>? OnPubAckSent { add { } remove { } }
    public event System.EventHandler<HiveMQtt.Client.Events.OnPubRecReceivedEventArgs>? OnPubRecReceived { add { } remove { } }
    public event System.EventHandler<HiveMQtt.Client.Events.OnPubRecSentEventArgs>? OnPubRecSent { add { } remove { } }
    public event System.EventHandler<HiveMQtt.Client.Events.OnPubRelReceivedEventArgs>? OnPubRelReceived { add { } remove { } }
    public event System.EventHandler<HiveMQtt.Client.Events.OnPubRelSentEventArgs>? OnPubRelSent { add { } remove { } }
    public event System.EventHandler<HiveMQtt.Client.Events.OnPubCompReceivedEventArgs>? OnPubCompReceived { add { } remove { } }
    public event System.EventHandler<HiveMQtt.Client.Events.OnPubCompSentEventArgs>? OnPubCompSent { add { } remove { } }
}
