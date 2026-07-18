using System.Globalization;
using System.Text.Json;
using HiveMQtt.Client;
using HiveMQtt.Client.Events;
using HiveMQtt.MQTT5.Types;
using Microsoft.Extensions.Hosting;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Models.Config;

namespace rPDU2MQTT.Services;

/// <summary>
/// Feeds energy-flow nodes from data already on the broker (#205) — Solar Assistant, CT clamps, an
/// inverter bridge — by subscribing to the topics bound in <c>EnergyFlow.Nodes[].Mqtt</c> and keeping the
/// latest value per (node, metric). <see cref="FlowGraphBuilder"/> reads it through
/// <see cref="IFlowValueSource"/>, so an MQTT-sourced node rolls up, exports and appears in Home
/// Assistant exactly like a PDU outlet does.
///
/// Subscriptions are reconciled on a timer rather than only at startup, so binding a topic in the GUI
/// takes effect without a restart (matching the rest of the app's live-reload behaviour).
/// </summary>
public sealed class EnergyFlowMqttSourceService : BackgroundService, IFlowValueSource
{
    private readonly HiveMQClient mqtt;
    private readonly Config cfg;
    // The staleness rules live in the cache (Core) so they're testable without a broker.
    private readonly FlowValueCache latest = new();
    // Topic -> the bindings fed by it. One topic may drive several nodes/metrics.
    private volatile Dictionary<string, List<(string NodeId, EnergyFlowSource Source)>> bindings = new(StringComparer.Ordinal);
    private readonly HashSet<string> subscribed = new(StringComparer.Ordinal);

    public EnergyFlowMqttSourceService(MQTTServiceDependencies deps)
    {
        // OnMessageReceived lives on the concrete client, not the interface.
        mqtt = deps.Mqtt as HiveMQClient
            ?? throw new InvalidOperationException("Expected a HiveMQClient instance for energy-flow MQTT sources.");
        cfg = deps.Cfg;
    }

    public bool TryGetValue(string nodeId, string metric, out double value)
        => latest.TryGetValue(nodeId, metric, out value);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        mqtt.OnMessageReceived += OnMessageReceived;
        try
        {
            using var timer = new PeriodicTimer(TimeSpan.FromSeconds(15));
            do
            {
                try { await Reconcile(stoppingToken); }
                catch (OperationCanceledException) { return; }
                catch (Exception ex) { Log.Warning($"Energy-flow MQTT sources: {ex.Message}"); }
            }
            while (await timer.WaitForNextTickAsync(stoppingToken));
        }
        catch (OperationCanceledException) { /* shutting down */ }
        finally { mqtt.OnMessageReceived -= OnMessageReceived; }
    }

    /// <summary>Bring the broker subscriptions in line with the current config (added/removed topics).</summary>
    private async Task Reconcile(CancellationToken ct)
    {
        var desired = BuildBindings(cfg.EnergyFlow.Nodes);
        bindings = desired;

        foreach (var topic in desired.Keys)
        {
            if (!subscribed.Add(topic)) continue;
            try
            {
                // AtLeastOnce so a value isn't silently dropped; retained messages arrive immediately, which
                // is what makes a restarted process pick up e.g. Solar Assistant's last reading at once.
                await mqtt.SubscribeAsync(topic, QualityOfService.AtLeastOnceDelivery);
                Log.Information($"Energy-flow: subscribed to {topic}.");
            }
            catch (Exception ex)
            {
                subscribed.Remove(topic);   // retry on the next pass
                Log.Warning($"Energy-flow: could not subscribe to {topic}: {ex.Message}");
            }
            if (ct.IsCancellationRequested) return;
        }

        foreach (var topic in subscribed.Where(t => !desired.ContainsKey(t)).ToList())
        {
            try
            {
                await mqtt.UnsubscribeAsync(topic);
                subscribed.Remove(topic);
                // Drop its cached readings too, so an unbound topic stops feeding the graph immediately.
                foreach (var key in latest.Keys.Where(k => BoundOnlyBy(k, topic))) latest.Remove(key.Node, key.Metric);
                Log.Information($"Energy-flow: unsubscribed from {topic}.");
            }
            catch (Exception ex) { Log.Warning($"Energy-flow: could not unsubscribe from {topic}: {ex.Message}"); }
        }
    }

    /// <summary>Is this cached (node, metric) no longer produced by any still-bound topic?</summary>
    private bool BoundOnlyBy((string Node, string Metric) key, string removedTopic)
    {
        foreach (var (topic, list) in bindings)
        {
            if (topic == removedTopic) continue;
            foreach (var (nodeId, src) in list)
                if (nodeId == key.Node && string.Equals(src.Metric, key.Metric, StringComparison.OrdinalIgnoreCase))
                    return false;
        }
        return true;
    }

    private void OnMessageReceived(object? sender, OnMessageReceivedEventArgs e)
        => Apply(bindings, latest, e.PublishMessage.Topic, e.PublishMessage.PayloadAsString, DateTime.UtcNow);

    /// <summary>
    /// Flatten the nodes' MQTT-type bindings into a topic → (node, source) lookup for the subscriber. Reads
    /// the new <see cref="EnergyFlowNode.Sources"/> and the legacy <see cref="EnergyFlowNode.Mqtt"/> together,
    /// and skips any binding whose <see cref="EnergyFlowSource.Type"/> this ingest doesn't handle.
    /// </summary>
    internal static Dictionary<string, List<(string NodeId, EnergyFlowSource Source)>> BuildBindings(IEnumerable<EnergyFlowNode> nodes)
    {
        var desired = new Dictionary<string, List<(string, EnergyFlowSource)>>(StringComparer.Ordinal);
        foreach (var node in nodes)
        {
            if (string.IsNullOrWhiteSpace(node.Id)) continue;
            foreach (var src in node.AllSources())
            {
                if (!string.Equals(src.Type, "mqtt", StringComparison.OrdinalIgnoreCase)) continue;   // this ingest only
                if (string.IsNullOrWhiteSpace(src.Topic) || string.IsNullOrWhiteSpace(src.Metric)) continue;
                var topic = src.Topic.Trim();
                if (!desired.TryGetValue(topic, out var list)) desired[topic] = list = new();
                list.Add((node.Id.Trim(), src));
            }
        }
        return desired;
    }

    /// <summary>
    /// Route one received message into the cache: for every (node, metric) bound to <paramref name="topic"/>,
    /// parse the payload, scale it, and store it. The broker callback and the tests share this so the whole
    /// subscribe → parse → cache glue is exercised without a live broker.
    /// </summary>
    internal static void Apply(
        IReadOnlyDictionary<string, List<(string NodeId, EnergyFlowSource Source)>> bindings,
        FlowValueCache cache, string? topic, string? payload, DateTime nowUtc)
    {
        if (topic is null || !bindings.TryGetValue(topic, out var list) || string.IsNullOrWhiteSpace(payload))
            return;

        foreach (var (nodeId, src) in list)
        {
            if (!TryParse(payload, src.JsonField, out var raw))
            {
                Log.Debug($"Energy-flow: could not read a number from {topic} for node '{nodeId}' (payload: {Truncate(payload)}).");
                continue;
            }
            cache.Set(nodeId, src.Metric, raw * src.Scale, src.StaleAfterSeconds, nowUtc);
        }
    }

    private static string Truncate(string s) => s.Length <= 80 ? s : s[..80] + "…";

    /// <summary>
    /// Read a number out of a payload: the bare value (Solar Assistant's <c>/state</c> topics), or
    /// <paramref name="jsonField"/> out of a JSON object (dotted for nesting).
    /// </summary>
    internal static bool TryParse(string payload, string? jsonField, out double value)
    {
        value = 0;
        payload = payload.Trim();
        if (string.IsNullOrEmpty(payload)) return false;

        if (string.IsNullOrWhiteSpace(jsonField))
            return double.TryParse(payload, NumberStyles.Any, CultureInfo.InvariantCulture, out value);

        try
        {
            using var doc = JsonDocument.Parse(payload);
            var el = doc.RootElement;
            foreach (var part in jsonField.Split('.', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                if (el.ValueKind != JsonValueKind.Object || !el.TryGetProperty(part, out el))
                    return false;
            }
            return el.ValueKind switch
            {
                JsonValueKind.Number => el.TryGetDouble(out value),
                // Numbers-as-strings are common in hand-rolled bridges.
                JsonValueKind.String => double.TryParse(el.GetString(), NumberStyles.Any, CultureInfo.InvariantCulture, out value),
                _ => false,
            };
        }
        catch (JsonException) { return false; }
    }
}
