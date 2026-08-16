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
public sealed class EnergyFlowMqttSourceService : BackgroundService, IFlowValueSource, IFlowValueDiagnostics, IWithheldSources, Core.Integrations.IIntegration, Core.Integrations.IStatusProvider
{
    // --- The integration contract ----------------------------------------------------------------------
    // Declared rather than converted: this already was a value source, and it keeps its own hosting because
    // it is a subscriber, not a poller — there is no cadence for the shared host to own.

    public string Id => "mqtt-source";
    public string DisplayName => "MQTT sources";
    public Core.Integrations.IntegrationGroup Group => Core.Integrations.IntegrationGroup.Integrations;

    /// <summary>On when something is bound to it — a broker connection alone is not a reason to subscribe.</summary>
    public bool Enabled(Config c) => Core.Integrations.SourceBindings.For(c, "mqtt").Count > 0;

    public Core.Integrations.IntegrationHealth Status(Config c)
    {
        var bound = Core.Integrations.SourceBindings.For(c, "mqtt").Count;
        if (bound == 0) return new(Core.Integrations.HealthLevel.Off, "No topics bound");

        // Withheld is its own state and the one worth seeing: the binding is right, the publisher has
        // stopped, and the node reads "no data" rather than a stale number.
        var withheld = ((IWithheldSources)this).Withheld.Count;
        return withheld > 0
            ? new(Core.Integrations.HealthLevel.Warn, "Some sources stale", $"{withheld} of {bound} binding(s) withheld")
            : new(Core.Integrations.HealthLevel.Good, "Subscribed", $"{bound} binding(s)");
    }

    private readonly HiveMQClient mqtt;
    private readonly Config cfg;
    // The staleness rules live in the cache (Core) so they're testable without a broker.
    private readonly FlowValueCache latest = new();
    // Topic -> the bindings fed by it. One topic may drive several nodes/metrics.
    private volatile Dictionary<string, List<(string NodeId, EnergyFlowSource Source)>> bindings = new(StringComparer.Ordinal);
    private readonly HashSet<string> subscribed = new(StringComparer.Ordinal);
    // v3: the subscription manager pushes each received value to the flow middleware (the FlowGrain) via this
    // sink — event-driven, no polling bridge. Null in tests / if not wired.
    private readonly ISnapshotSink<MeasurementSnapshot>? sink;
    private long version;
    private long received;
    // The audit's verdicts belong to one owner cluster-wide, so they live in IPeriodAuditGrain rather than
    // here: two ingests each keeping their own map wrote back over one shared record and erased each other,
    // and two replicas would have reached the verdict separately.
    private readonly IPeriodAuditor? auditor;

    /// <summary>Bindings whose readings are being dropped, so the GUI can say so where the number is missing.</summary>
    public IReadOnlyCollection<WithheldSource> Withheld => withheld;
    private volatile WithheldSource[] withheld = [];

    public EnergyFlowMqttSourceService(MQTTServiceDependencies deps, ISnapshotSink<MeasurementSnapshot>? sink = null,
                                       IPeriodAuditor? auditor = null)
    {
        // OnMessageReceived lives on the concrete client, not the interface.
        mqtt = deps.Mqtt as HiveMQClient
            ?? throw new InvalidOperationException("Expected a HiveMQClient instance for energy-flow MQTT sources.");
        cfg = deps.Cfg;
        this.sink = sink;
        this.auditor = auditor;
    }

    public bool TryGetValue(string nodeId, string metric, out double value)
        => latest.TryGetValue(nodeId, metric, out value);

    // Freshness passes straight through to the cache, so the GUI can distinguish "never reported" from
    // "stopped reporting" without reaching past this service into its private cache.
    public bool TryDescribe(string nodeId, string metric, out FlowReading reading)
        => latest.TryDescribe(nodeId, metric, out reading);

    public IReadOnlyCollection<(string Node, string Metric)> ReportedKeys => latest.Keys;

    // Set when the client reconnects: everything in `subscribed` is a stale belief at that point and the
    // next reconcile must re-establish it. A flag rather than clearing the set from the event thread, so
    // `subscribed` is only ever mutated by the reconcile loop.
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

    /// <summary>Bring the broker subscriptions in line with the current config (added/removed topics).</summary>
    private long lastDesiredCount = -1;

    private async Task Reconcile(CancellationToken ct)
    {
        // A reconnect leaves the broker with no session and the client with an empty subscription list, so
        // every topic in `subscribed` is now a belief about a subscription that no longer exists. Without
        // this, `subscribed.Add` below reports "already done" and the ingest never re-subscribes — the
        // process keeps running, keeps reporting healthy, and silently receives nothing until it restarts.
        if (connectionReset)
        {
            connectionReset = false;
            if (subscribed.Count > 0)
                Log.Information($"Energy-flow: MQTT reconnected — re-establishing {subscribed.Count} subscription(s).");
            subscribed.Clear();
        }

        var desired = BuildBindings(cfg.EnergyFlow.Nodes);
        bindings = desired;

        // Make "did it find any bindings" visible without turning on Debug — the silent failure mode is a
        // reconcile that quietly finds zero MQTT sources and subscribes to nothing.
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
                // AtLeastOnce so a value isn't silently dropped; retained messages arrive immediately, which
                // is what makes a restarted process pick up e.g. Solar Assistant's last reading at once.
                var result = await MqttSubscriptions.SubscribeAsync(mqtt, topic, QualityOfService.AtLeastOnceDelivery);

                // A broker can *deny* a subscription (ACL) and the client reports it in the SUBACK, not as an
                // exception. Treating that as success is how the ingest dies silently — check it, like the
                // outlet command handler does, and let a denied topic retry rather than sticking.
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
                MqttSubscriptions.Forget(topic);   // else the reconnect replay resurrects it
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
                if (nodeId == key.Node && FlowMetricKey.Keys(FlowMetricKey.ForAccumulation(src.Metric, src.Accumulation), src.Direction).Any(k => string.Equals(k, key.Metric, StringComparison.OrdinalIgnoreCase)))
                    return false;
        }
        return true;
    }

    /// <summary>
    /// Ask the audit's owner whether this reading may be published as the day's total.
    ///
    /// <para>
    /// Only reached for a source declared <c>period</c>, so the grain is not on a per-message path — an
    /// install with none never calls it. The call is awaited: withholding is a correctness decision, and
    /// publishing first and asking after would put the figure out before the answer came back.
    /// </para>
    /// </summary>
    private bool Audit(string nodeId, string source, string? direction, string periodKey, double value)
    {
        if (auditor is null) return true;   // no owner wired (tests): nothing is withheld
        try
        {
            var allowed = auditor.Allow(nodeId, source, direction, periodKey, value);
            withheld = [.. auditor.Withheld];
            return allowed;
        }
        catch (Exception ex)
        {
            // An unreachable owner must not stop the ingest. Publishing the reading is the pre-audit
            // behaviour, and the next reading re-asks.
            Log.Debug($"Energy-flow: could not consult the period audit ({ex.Message}).");
            return true;
        }
    }

    /// <summary>The period a reading now belongs to, on the same boundary the daily accumulator uses.</summary>
    private string CurrentPeriodKey(DateTime nowUtc)
    {
        var agg = cfg.EnergyFlow.Aggregation;
        return EnergyPeriod.KeyFor(nowUtc, EnergyPeriod.Resolve(agg.PeriodTimeZone), agg.PeriodStartHour);
    }

    private void OnMessageReceived(object? sender, OnMessageReceivedEventArgs e)
    {
        var now = DateTime.UtcNow;
        // Collect the readings this message produced (only if a sink is wired) and push them to the flow grain
        // event-driven — the "subscription manager routes events to the recipient grain" (#v3).
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
        FlowValueCache cache, string? topic, string? payload, DateTime nowUtc,
        Action<string, string, double, int>? onReading = null,
        Func<string, string, string?, string, double, bool>? auditor = null,
        string? periodKey = null)
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
            // Normalise to the metric's canonical unit (kW -> W, Wh -> kWh, …) so the roll-up and exports are
            // consistent, then apply the manual Scale (sign flips / oddball adjustments) on top.
            var value = raw * FlowUnits.ToCanonicalFactor(src.Metric, src.Unit) * src.Scale;
            // Fan the reading into its direction(s): normally one key, but a 'split' source (a single signed
            // value) writes both the out (positive part) and in (negative magnitude) keys. The 'in' key is
            // direction-qualified so it doesn't overwrite the out supply value, and — being a non-metric key —
            // is skipped by the grain sink below (Metrics.TryParse fails), keeping charge/export out of the flow.
            // A 'period' energy counter is reset by the device each day, so it already IS the daily total —
            // store it under the daily metric rather than pretending it is cumulative and measuring its
            // "rise", which loses the whole day every time the device rolls it over.
            // A source declared 'period' is published as the day's total with no arithmetic in between, so
            // the claim has to be checked rather than trusted: a counter that resets daily must be lower at
            // the start of a period than it was at the end of the last one. When it isn't, the number is not
            // today's — it is a cumulative total, or a value the device stopped updating before the rollover
            // — and it is dropped rather than stated. The node then reports "no data" for today, which is
            // the truth, instead of a confident wrong figure.
            if (auditor is not null && periodKey is not null && PeriodCounterAudit.Applies(src)
                && !auditor(nodeId, topic, src.Direction, periodKey, value))
                continue;

            foreach (var (key, v) in FlowMetricKey.Fan(FlowMetricKey.ForAccumulation(src.Metric, src.Accumulation), src.Direction, value))
            {
                cache.Set(nodeId, key, v, src.StaleAfterSeconds, nowUtc);
                onReading?.Invoke(nodeId, key, v, src.StaleAfterSeconds);
            }
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
