using System.Globalization;
using System.Text.Json;
using HiveMQtt.Client;
using HiveMQtt.Client.Events;
using HiveMQtt.MQTT5.Types;
using Microsoft.Extensions.Hosting;
using rPDU2MQTT.Abstractions.Flow;
using rPDU2MQTT.Abstractions.Pipeline;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Models.Config;

namespace rPDU2MQTT.Services;

/// <summary>Feeds energy-flow nodes from MQTT topics bound in their sources.</summary>
public sealed class EnergyFlowMqttSourceService : BackgroundService, IFlowValueSource, IFlowValueDiagnostics, IWithheldSources, Core.Integrations.IIntegration, Core.Integrations.IStatusProvider
{
    public string Id => "mqtt-source";
    public string DisplayName => "MQTT sources";
    public Core.Integrations.IntegrationGroup Group => Core.Integrations.IntegrationGroup.Integrations;

    /// <summary>On when any topic is bound.</summary>
    public bool Enabled(Config c) => Core.Integrations.SourceBindings.For(c, "mqtt").Count > 0;

    public Core.Integrations.IntegrationHealth Status(Config c)
    {
        var bound = Core.Integrations.SourceBindings.For(c, "mqtt").Count;
        if (bound == 0) return new(Core.Integrations.HealthLevel.Off, "No topics bound");

        var withheld = ((IWithheldSources)this).Withheld.Count;
        return withheld > 0
            ? new(Core.Integrations.HealthLevel.Warn, "Some sources stale", $"{withheld} of {bound} binding(s) withheld")
            : new(Core.Integrations.HealthLevel.Good, "Subscribed", $"{bound} binding(s)");
    }

    private readonly HiveMQClient mqtt;
    private readonly Config cfg;
    private readonly FlowValueCache latest = new();
    private volatile Dictionary<string, List<(string NodeId, EnergyFlowSource Source)>> bindings = new(StringComparer.Ordinal);
    private readonly HashSet<string> subscribed = new(StringComparer.Ordinal);
    private readonly ISnapshotSink<MeasurementSnapshot>? sink;
    private long version;
    private long received;
    private readonly IPeriodAuditor? auditor;

    /// <summary>Bindings whose readings are being withheld.</summary>
    public IReadOnlyCollection<WithheldSource> Withheld =>
        auditor is null ? [] : [.. auditor.Withheld.Where(w => bindings.ContainsKey(w.Source))];

    public EnergyFlowMqttSourceService(MQTTServiceDependencies deps, ISnapshotSink<MeasurementSnapshot>? sink = null,
                                       IPeriodAuditor? auditor = null)
    {
        mqtt = deps.Mqtt as HiveMQClient
            ?? throw new InvalidOperationException("Expected a HiveMQClient instance for energy-flow MQTT sources.");
        cfg = deps.Cfg;
        this.sink = sink;
        this.auditor = auditor;
    }

    public bool TryGetValue(string nodeId, string metric, out double value)
        => latest.TryGetValue(nodeId, metric, out value);

    public bool TryDescribe(string nodeId, string metric, out FlowReading reading)
        => latest.TryDescribe(nodeId, metric, out reading);

    public IReadOnlyCollection<(string Node, string Metric)> ReportedKeys => latest.Keys;

    private volatile bool connectionReset;

    private void OnReconnected(object? sender, HiveMQtt.Client.Events.AfterConnectEventArgs e)
    {
        connectionReset = true;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        Log.Information("Energy-flow MQTT ingest started — reconciling broker subscriptions from EnergyFlow.Nodes.");
        mqtt.OnMessageReceived += OnMessageReceived;
        mqtt.AfterConnect += OnReconnected;
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
        finally { mqtt.OnMessageReceived -= OnMessageReceived; mqtt.AfterConnect -= OnReconnected; }
    }

    /// <summary>Bring the broker subscriptions in line with the config.</summary>
    private long lastDesiredCount = -1;

    private async Task Reconcile(CancellationToken ct)
    {
        if (connectionReset)
        {
            connectionReset = false;
            if (subscribed.Count > 0)
                Log.Information($"Energy-flow: MQTT reconnected — re-establishing {subscribed.Count} subscription(s).");
            subscribed.Clear();
        }

        var desired = BuildBindings(Core.Integrations.SourceBindings.Nodes(cfg));
        bindings = desired;

        var bindingCount = desired.Values.Sum(v => v.Count);
        if (bindingCount != lastDesiredCount)
        {
            Log.Information($"Energy-flow MQTT ingest: {bindingCount} binding(s) across {desired.Count} topic(s) from {cfg.EnergyFlow.Nodes.Count} node(s).");
            lastDesiredCount = bindingCount;
        }

        foreach (var topic in desired.Keys)
        {
            if (!subscribed.Add(topic)) continue;
            try
            {
                var result = await MqttSubscriptions.SubscribeAsync(mqtt, topic, QualityOfService.AtLeastOnceDelivery);

                var granted = result.Subscriptions.All(sub => (int)sub.SubscribeReasonCode <= 2);
                if (granted)
                {
                    Log.Information($"Energy-flow: subscribed to {topic}.");
                }
                else
                {
                    subscribed.Remove(topic);
                    var codes = string.Join(", ", result.Subscriptions.Select(sub => sub.SubscribeReasonCode.ToString()));
                    Log.Error($"Energy-flow: subscription to {topic} was NOT granted ({codes}). The MQTT account likely lacks read permission on this topic — no values will arrive for the nodes bound to it.");
                }
            }
            catch (Exception ex)
            {
                subscribed.Remove(topic);
                Log.Warning($"Energy-flow: could not subscribe to {topic}: {ex.Message}");
            }
            if (ct.IsCancellationRequested) return;
        }

        foreach (var topic in subscribed.Where(t => !desired.ContainsKey(t)).ToList())
        {
            try
            {
                await mqtt.UnsubscribeAsync(topic);
                MqttSubscriptions.Forget(topic);
                subscribed.Remove(topic);
                foreach (var key in latest.Keys.Where(k => BoundOnlyBy(k, topic))) latest.Remove(key.Node, key.Metric);
                Log.Information($"Energy-flow: unsubscribed from {topic}.");
            }
            catch (Exception ex) { Log.Warning($"Energy-flow: could not unsubscribe from {topic}: {ex.Message}"); }
        }
    }

    /// <summary>True when no other bound topic writes this (node, metric).</summary>
    private bool BoundOnlyBy((string Node, string Metric) key, string removedTopic)
    {
        foreach (var (topic, list) in bindings)
        {
            if (topic == removedTopic) continue;
            foreach (var (nodeId, src) in list)
                if (nodeId == key.Node && FlowMetricKey.Keys(FlowMetricKey.ForAccumulation(src.Metric, src.Accumulation), src.Direction).Any(k => string.Equals(k, key.Metric, StringComparison.OrdinalIgnoreCase)))
                    return false;
        }
        return true;
    }

    /// <summary>Whether this reading may be published as the day's total.</summary>
    private bool Audit(string nodeId, string source, string? direction, string periodKey, double value)
    {
        if (auditor is null) return true;
        try
        {
            var allowed = auditor.Allow(nodeId, source, direction, periodKey, value);
            return allowed;
        }
        catch (Exception ex)
        {
            Log.Debug($"Energy-flow: could not consult the period audit ({ex.Message}).");
            return true;
        }
    }

    /// <summary>The period a reading belongs to.</summary>
    private string CurrentPeriodKey(DateTime nowUtc)
    {
        var agg = cfg.EnergyFlow.Aggregation;
        return EnergyPeriod.KeyFor(nowUtc, EnergyPeriod.Resolve(agg.PeriodTimeZone), agg.PeriodStartHour);
    }

    private void OnMessageReceived(object? sender, OnMessageReceivedEventArgs e)
    {
        var now = DateTime.UtcNow;
        List<MeasurementReading>? readings = sink is null ? null : new();
        Apply(bindings, latest, e.PublishMessage.Topic, e.PublishMessage.PayloadAsString, now,
            readings is null ? null : (node, metric, value, stale) =>
            {
                if (Metrics.TryParse(metric, out var m)) readings.Add(new MeasurementReading(node, m, value, stale));
            },
            Audit, CurrentPeriodKey(now));

        if (sink is not null && readings is { Count: > 0 })
        {
            _ = sink.EmitAsync(new MeasurementSnapshot("mqtt", now, System.Threading.Interlocked.Increment(ref version), readings));
            if (System.Threading.Interlocked.Increment(ref received) is var n && (n == 1 || n % 100 == 0))
                Log.Information($"Energy-flow MQTT ingest: received {n} message(s); latest from '{e.PublishMessage.Topic}' → {readings.Count} reading(s).");
        }
    }

    /// <summary>Topic → (node, source) lookup for the nodes' MQTT bindings.</summary>
    internal static Dictionary<string, List<(string NodeId, EnergyFlowSource Source)>> BuildBindings(IEnumerable<EnergyFlowNode> nodes)
    {
        var desired = new Dictionary<string, List<(string, EnergyFlowSource)>>(StringComparer.Ordinal);
        foreach (var node in nodes)
        {
            if (string.IsNullOrWhiteSpace(node.Id)) continue;
            foreach (var src in node.AllSources())
            {
                if (!string.Equals(src.Type, "mqtt", StringComparison.OrdinalIgnoreCase)) continue;
                if (string.IsNullOrWhiteSpace(src.Topic) || string.IsNullOrWhiteSpace(src.Metric)) continue;
                var topic = src.Topic.Trim();
                if (!desired.TryGetValue(topic, out var list)) desired[topic] = list = new();
                list.Add((node.Id.Trim(), src));
            }
        }
        return desired;
    }

    /// <summary>Route one received message into the cache.</summary>
    internal static void Apply(
        IReadOnlyDictionary<string, List<(string NodeId, EnergyFlowSource Source)>> bindings,
        FlowValueCache cache, string? topic, string? payload, DateTime nowUtc,
        Action<string, string, double, int>? onReading = null,
        Func<string, string, string?, string, double, bool>? auditor = null,
        string? periodKey = null)
    {
        if (topic is null || !bindings.TryGetValue(topic, out var list) || string.IsNullOrWhiteSpace(payload))
            return;

        var sums = PartsByKey.GetValue(bindings, BuildParts);

        foreach (var (nodeId, src) in list)
        {
            if (!TryParse(payload, src.JsonField, out var raw))
            {
                Log.Debug($"Energy-flow: could not read a number from {topic} for node '{nodeId}' (payload: {Truncate(payload)}).");
                continue;
            }
            var value = raw * FlowUnits.ToCanonicalFactor(src.Metric, src.Unit) * src.Scale;
            if (auditor is not null && periodKey is not null && PeriodCounterAudit.Applies(src)
                && !auditor(nodeId, topic, src.Direction, periodKey, value))
                continue;

            var part = PartId(topic, src);
            foreach (var (key, v) in FlowMetricKey.Fan(FlowMetricKey.ForAccumulation(src.Metric, src.Accumulation), src.Direction, value))
            {
                IReadOnlyCollection<string> expected = sums.TryGetValue((nodeId, key), out var e) ? e : new[] { part };
                if (!cache.SetPart(nodeId, key, part, expected, v, src.StaleAfterSeconds, nowUtc, out var total)) continue;
                onReading?.Invoke(nodeId, key, total, src.StaleAfterSeconds);
            }
        }
    }

    private static readonly System.Runtime.CompilerServices.ConditionalWeakTable<
        IReadOnlyDictionary<string, List<(string NodeId, EnergyFlowSource Source)>>,
        Dictionary<(string Node, string Key), HashSet<string>>> PartsByKey = new();

    private static string PartId(string topic, EnergyFlowSource src) => topic + "\n" + src.JsonField;

    /// <summary>The sources writing each (node, key).</summary>
    private static Dictionary<(string Node, string Key), HashSet<string>> BuildParts(
        IReadOnlyDictionary<string, List<(string NodeId, EnergyFlowSource Source)>> bindings)
    {
        var map = new Dictionary<(string, string), HashSet<string>>();
        foreach (var (topic, list) in bindings)
            foreach (var (nodeId, src) in list)
                foreach (var key in FlowMetricKey.Keys(FlowMetricKey.ForAccumulation(src.Metric, src.Accumulation), src.Direction))
                {
                    if (!map.TryGetValue((nodeId, key), out var set)) map[(nodeId, key)] = set = new(StringComparer.Ordinal);
                    set.Add(PartId(topic, src));
                }
        return map;
    }

    private static string Truncate(string s) => s.Length <= 80 ? s : s[..80] + "…";

    /// <summary>Read a number from a bare payload or a dotted JSON field.</summary>
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
                JsonValueKind.String => double.TryParse(el.GetString(), NumberStyles.Any, CultureInfo.InvariantCulture, out value),
                _ => false,
            };
        }
        catch (JsonException) { return false; }
    }
}
