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
    private string? subscribedFilter;   // the filter currently subscribed on the broker, or null

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

        if (subscribedFilter is not null) await StopListening();
    }

    private async Task PumpAsync()
    {
        var index = grains.GetGrain<ITopicIndexGrain>(0);
        var wanted = await index.DesiredFilter();   // the filter to browse, or "" when nobody is browsing

        // Re-subscribe when the wanted filter changes (the user narrowed it, e.g. to solar_assistant/#).
        if (string.IsNullOrEmpty(wanted))
        {
            if (subscribedFilter is not null) await StopListening();
            return;
        }
        if (subscribedFilter != wanted)
        {
            if (subscribedFilter is not null) await StopListening();
            await StartListening(wanted, index);
        }
        if (subscribedFilter is null) return;

        // Hand over what we've seen (an empty batch still says "the subscription is open").
        var batch = buffer.Keys.Take(MaxBuffered).ToList();
        var samples = new List<TopicSample>(batch.Count);
        foreach (var topic in batch)
            if (buffer.TryRemove(topic, out var sample)) samples.Add(sample);

        await index.Observe(samples);
    }

    private async Task StartListening(string filter, ITopicIndexGrain index)
    {
        try
        {
            mqtt.OnMessageReceived += OnMessageReceived;
            var result = await mqtt.SubscribeAsync(filter, QualityOfService.AtMostOnceDelivery);
            subscribedFilter = filter;

            // A broker can *deny* the subscription (an ACL that forbids the wildcard) and report it in the
            // SUBACK, not as an exception. Unchecked, that's a silently-empty browser on a working broker.
            var granted = result.Subscriptions.All(sub => (int)sub.SubscribeReasonCode <= 2);
            await index.ReportSubscription(granted);
            if (granted)
                Serilog.Log.Information($"Topic index: subscribed to '{filter}' while the Nodes editor is browsing.");
            else
                Serilog.Log.Warning($"Topic index: the broker DENIED the subscription to '{filter}' — the MQTT account likely lacks read permission on it. The topic browser will stay empty; grant it, or browse a narrower prefix.");
        }
        catch (Exception ex)
        {
            mqtt.OnMessageReceived -= OnMessageReceived;
            subscribedFilter = null;
            Serilog.Log.Warning($"Topic index: could not subscribe to '{filter}': {ex.Message}");
        }
    }

    private async Task StopListening()
    {
        var filter = subscribedFilter;
        subscribedFilter = null;
        mqtt.OnMessageReceived -= OnMessageReceived;
        buffer.Clear();
        if (filter is null) return;
        try
        {
            await mqtt.UnsubscribeAsync(filter);
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
