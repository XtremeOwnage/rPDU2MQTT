using System.Text.Json;
using HiveMQtt.Client;
using HiveMQtt.Client.Events;
using HiveMQtt.MQTT5.Types;
using Microsoft.Extensions.Hosting;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core;
using rPDU2MQTT.Core.Transport;
using rPDU2MQTT.Helpers;

namespace rPDU2MQTT.Services;

/// <summary>
/// Bridges the in-process snapshot bus (<see cref="IMessageBus"/>) across processes over MQTT, so the app
/// can run as separate role processes (#127). A producer (Worker) node maps each local snapshot to the
/// round-trippable <see cref="RawSnapshot"/> wire form and publishes it to a retained broker topic; a
/// consumer-only (API/UI) node ingests those back onto its own bus — and therefore its
/// <see cref="SnapshotCache"/> — without polling any PDU itself.
/// <para>
/// Only registered when roles are split; a single-node "all" deployment keeps the bus entirely in-process
/// and never loads this, so there's no extra broker traffic by default.
/// </para>
/// Topic: <c>&lt;parentTopic&gt;/_bus/snapshot/&lt;instanceId&gt;</c> (retained, so a late consumer gets the latest at once).
/// <para>
/// Note: <see cref="RawSnapshot"/> carries the raw poll data only; a consumer still needs to run the
/// naming/override transform to populate display names. That consumer-side transform is the next step.
/// </para>
/// </summary>
public sealed class MqttBusBridge : IHostedService
{
    public const string BusSegment = "_bus";
    public const string SnapshotSegment = "snapshot";
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly HiveMQClient mqtt;
    private readonly IMessageBus bus;
    private readonly Config cfg;
    private readonly bool producer;
    private readonly CancellationTokenSource cts = new();
    private Task? pump;

    public MqttBusBridge(IHiveMQClient mqtt, IMessageBus bus, Config cfg, bool producer)
    {
        this.mqtt = (HiveMQClient)mqtt;
        this.bus = bus;
        this.cfg = cfg;
        this.producer = producer;
    }

    /// <summary>The retained per-instance snapshot topic a producer publishes to / a consumer subscribes under.</summary>
    public static string TopicFor(string parentTopic, string instanceId) =>
        MQTTHelper.JoinPaths(parentTopic, BusSegment, SnapshotSegment, instanceId);

    private string SubscriptionFilter => MQTTHelper.JoinPaths(cfg.MQTT.ParentTopic, BusSegment, SnapshotSegment, "+");

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        if (producer)
        {
            pump = Task.Run(() => PumpOutboundAsync(cts.Token), CancellationToken.None);
            Log.Information($"MQTT bus bridge: mirroring local snapshots to '{MQTTHelper.JoinPaths(cfg.MQTT.ParentTopic, BusSegment, SnapshotSegment)}/<instance>'.");
            return;
        }

        mqtt.OnMessageReceived += OnMessageReceived;
        var result = await mqtt.SubscribeAsync(SubscriptionFilter, QualityOfService.AtLeastOnceDelivery);
        foreach (var sub in result.Subscriptions)
        {
            if ((int)sub.SubscribeReasonCode <= 2)
                Log.Information($"MQTT bus bridge: ingesting remote snapshots from '{sub.TopicFilter.Topic}'.");
            else
                Log.Error($"MQTT bus bridge: subscription to '{sub.TopicFilter.Topic}' was not granted ({sub.SubscribeReasonCode}); this node will have no PDU data.");
        }
    }

    private async Task PumpOutboundAsync(CancellationToken ct)
    {
        try
        {
            await foreach (var snapshot in bus.Subscribe(cancellationToken: ct))
            {
                // One bad snapshot must not stop the pump for the rest.
                try
                {
                    var wire = RawSnapshotMapper.ToWire(snapshot.InstanceId, snapshot.TimestampUtc, snapshot.Data);
                    await mqtt.PublishAsync(new MQTT5PublishMessage(TopicFor(cfg.MQTT.ParentTopic, snapshot.InstanceId), QualityOfService.AtLeastOnceDelivery)
                    {
                        PayloadAsString = JsonSerializer.Serialize(wire, Json),
                        Retain = true,
                    });
                }
                catch (Exception ex) { Log.Warning($"MQTT bus bridge: could not mirror a '{snapshot.InstanceId}' snapshot: {ex.Message}"); }
            }
        }
        catch (OperationCanceledException) { /* shutting down */ }
        catch (Exception ex) { Log.Error(ex, "MQTT bus bridge: outbound pump stopped."); }
    }

    private void OnMessageReceived(object? sender, OnMessageReceivedEventArgs e)
    {
        try
        {
            var json = e.PublishMessage.PayloadAsString;
            if (string.IsNullOrEmpty(json)) return;
            var wire = JsonSerializer.Deserialize<RawSnapshot>(json, Json);
            if (wire is null || string.IsNullOrEmpty(wire.InstanceId)) return;
            _ = bus.PublishAsync(new PduSnapshot(wire.InstanceId, wire.TimestampUtc, RawSnapshotMapper.ToData(wire)));
        }
        catch (Exception ex)
        {
            Log.Warning($"MQTT bus bridge: could not ingest a snapshot from '{e.PublishMessage.Topic}': {ex.Message}");
        }
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        if (producer)
        {
            cts.Cancel();
            if (pump is not null)
                try { await pump; } catch { /* ignore shutdown races */ }
        }
        else
        {
            mqtt.OnMessageReceived -= OnMessageReceived;
        }
    }
}
