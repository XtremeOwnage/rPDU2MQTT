using System.Collections.Concurrent;
using System.Text;
using HiveMQtt.Client;
using HiveMQtt.Client.Events;
using HiveMQtt.MQTT5.Types;
using Microsoft.Extensions.Hosting;
using Orleans;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Grains.Abstractions.Discovery;

namespace rPDU2MQTT.Hosting;

/// <summary>
/// Feeds the browsable topic index — but only while someone is browsing.
/// <para>
/// It polls <see cref="ITopicIndexGrain.Wanted"/>, and only then opens a wildcard subscription, forwarding
/// what arrives in batches. The moment the lease lapses it unsubscribes and drops its buffer. So the cost of
/// topic autocomplete is a subscription for as long as the Nodes editor is open, and zero after that — never
/// a background process quietly indexing the whole broker for the life of the deployment.
/// </para>
/// <para>Payloads are truncated and the buffer is capped, so even a firehose can't run this away.</para>
/// </summary>
public sealed class MqttTopicIndexService : BackgroundService
{
    /// <summary>Longest payload sample kept — enough to see a number or a small JSON document.</summary>
    private const int MaxPayloadChars = 512;

    /// <summary>Most topics buffered between flushes; past this, new topics wait for the next window.</summary>
    private const int MaxBuffered = 1000;

    private readonly HiveMQClient mqtt;
    private readonly IGrainFactory grains;
    private readonly ConcurrentDictionary<string, TopicSample> buffer = new(StringComparer.Ordinal);
    private bool subscribed;

    public MqttTopicIndexService(MQTTServiceDependencies deps, IGrainFactory grains)
    {
        mqtt = deps.Mqtt as HiveMQClient
            ?? throw new InvalidOperationException("Expected a HiveMQClient instance for topic indexing.");
        this.grains = grains;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try { await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken); } catch (OperationCanceledException) { return; }

        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(3));
        do
        {
            try { await PumpAsync(); }
            catch (Exception ex) { Serilog.Log.Debug($"Topic index: {ex.Message}"); }
        }
        while (await SafeWait(timer, stoppingToken));

        if (subscribed) await StopListening();
    }

    private async Task PumpAsync()
    {
        var index = grains.GetGrain<ITopicIndexGrain>(0);
        var wanted = await index.Wanted();

        if (wanted && !subscribed) await StartListening();
        else if (!wanted && subscribed) await StopListening();

        if (!subscribed) return;

        // Hand over what we've seen (an empty batch still says "the subscription is open").
        var batch = buffer.Keys.Take(MaxBuffered).ToList();
        var samples = new List<TopicSample>(batch.Count);
        foreach (var topic in batch)
            if (buffer.TryRemove(topic, out var sample)) samples.Add(sample);

        await index.Observe(samples);
    }

    private async Task StartListening()
    {
        try
        {
            mqtt.OnMessageReceived += OnMessageReceived;
            await mqtt.SubscribeAsync("#", QualityOfService.AtMostOnceDelivery);
            subscribed = true;
            Serilog.Log.Information("Topic index: subscribed to # while the Nodes editor is browsing.");
        }
        catch (Exception ex)
        {
            mqtt.OnMessageReceived -= OnMessageReceived;
            Serilog.Log.Warning($"Topic index: could not subscribe: {ex.Message}");
        }
    }

    private async Task StopListening()
    {
        subscribed = false;
        mqtt.OnMessageReceived -= OnMessageReceived;
        buffer.Clear();
        try
        {
            await mqtt.UnsubscribeAsync("#");
            Serilog.Log.Information("Topic index: nobody is browsing; unsubscribed.");
        }
        catch (Exception ex) { Serilog.Log.Debug($"Topic index: unsubscribe failed: {ex.Message}"); }
    }

    private void OnMessageReceived(object? sender, OnMessageReceivedEventArgs e)
    {
        var topic = e.PublishMessage.Topic;
        if (string.IsNullOrEmpty(topic) || topic.StartsWith("$SYS", StringComparison.Ordinal)) return;

        // Bounded: once the buffer is full, keep refreshing what we already track and let the rest go.
        if (buffer.Count >= MaxBuffered && !buffer.ContainsKey(topic)) return;

        var payload = e.PublishMessage.PayloadAsString ?? "";
        if (payload.Length > MaxPayloadChars) payload = payload[..MaxPayloadChars];

        buffer[topic] = new TopicSample { Topic = topic, Payload = payload, SeenUtc = DateTime.UtcNow };
    }

    private static async Task<bool> SafeWait(PeriodicTimer timer, CancellationToken ct)
    {
        try { return await timer.WaitForNextTickAsync(ct); }
        catch (OperationCanceledException) { return false; }
    }
}
