using System.Collections.Concurrent;
using System.Text.Json;
using HiveMQtt.Client;
using HiveMQtt.Client.Events;
using HiveMQtt.MQTT5.Types;
using Microsoft.Extensions.Hosting;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core;
using rPDU2MQTT.Helpers;

namespace rPDU2MQTT.Services;

/// <summary>
/// Publishes this process's <see cref="Heartbeat"/> and listens for the others', so a split deployment can
/// show every role process on the diagnostics page — including ones with no PDU data (#127). Only loaded
/// when roles are split; a single-node "all" deployment has nothing to discover.
/// <para>Topic: <c>&lt;parentTopic&gt;/_bus/heartbeat/&lt;id&gt;</c> (retained; a clean shutdown clears it).</para>
/// </summary>
public sealed class HeartbeatService : IHostedService
{
    private const string BusSegment = "_bus";
    private const string HeartbeatSegment = "heartbeat";
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly HiveMQClient mqtt;
    private readonly Config cfg;
    private readonly EmonCmsStatus emon;
    private readonly Heartbeat self;
    private readonly ConcurrentDictionary<string, Heartbeat> seen = new(StringComparer.OrdinalIgnoreCase);
    private readonly CancellationTokenSource cts = new();
    private Task? pump;

    public HeartbeatService(IHiveMQClient mqtt, Config cfg, HostRole roles, EmonCmsStatus emon)
    {
        this.mqtt = (HiveMQClient)mqtt;
        this.cfg = cfg;
        this.emon = emon;

        var roleNames = new[] { HostRole.Worker, HostRole.Api, HostRole.Ui }.Where(r => roles.HasFlag(r)).Select(r => r.ToString().ToLowerInvariant()).ToArray();
        var host = Environment.GetEnvironmentVariable("RPDU2MQTT_POD_NAME") ?? Environment.MachineName;
        var rawId = $"{string.Join('-', roleNames)}-{host}-{Guid.NewGuid():N}".ToLowerInvariant();
        var id = Sanitize(rawId.Length > 80 ? rawId[..80] : rawId);
        var version = rPDU2MQTT.Helpers.AppInfo.Version;
        self = new Heartbeat(id, roleNames, host, DateTime.UtcNow, DateTime.UtcNow, version);
    }

    private static string Sanitize(string s) => new(s.Select(c => char.IsLetterOrDigit(c) || c is '-' or '_' or '.' ? c : '-').ToArray());

    private string TopicFor(string id) => MQTTHelper.JoinPaths(cfg.MQTT.ParentTopic, BusSegment, HeartbeatSegment, id);

    /// <summary>Every process seen recently (this one included), freshest reported via <see cref="Heartbeat.TimestampUtc"/>.</summary>
    public IReadOnlyCollection<Heartbeat> Processes => seen.Values.ToArray();

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        seen[self.Id] = self with { TimestampUtc = DateTime.UtcNow };
        mqtt.OnMessageReceived += OnMessageReceived;
        var result = await mqtt.SubscribeAsync(MQTTHelper.JoinPaths(cfg.MQTT.ParentTopic, BusSegment, HeartbeatSegment, "+"), QualityOfService.AtLeastOnceDelivery);
        foreach (var sub in result.Subscriptions)
            if ((int)sub.SubscribeReasonCode > 2)
                Log.Warning($"Heartbeat: subscription to '{sub.TopicFilter.Topic}' not granted ({sub.SubscribeReasonCode}); other processes won't be listed.");
        pump = Task.Run(() => PumpAsync(cts.Token), CancellationToken.None);
        Log.Information($"Heartbeat: announcing '{self.Id}' (roles: {string.Join(", ", self.Roles)}).");
    }

    private async Task PumpAsync(CancellationToken ct)
    {
        try
        {
            using var timer = new PeriodicTimer(TimeSpan.FromSeconds(Heartbeat.IntervalSeconds));
            do
            {
                // Only the process actually exporting (the worker) has attempted an export; carry its status
                // so a split API/UI node can show the true EmonCMS health on the Status board.
                var beat = self with { TimestampUtc = DateTime.UtcNow, EmonCms = emon.HasAttempted ? emon.Snapshot() : null };
                seen[beat.Id] = beat;
                await mqtt.PublishAsync(new MQTT5PublishMessage(TopicFor(beat.Id), QualityOfService.AtLeastOnceDelivery)
                {
                    PayloadAsString = JsonSerializer.Serialize(beat, Json),
                    Retain = true,
                });
            }
            while (await timer.WaitForNextTickAsync(ct));
        }
        catch (OperationCanceledException) { /* shutting down */ }
        catch (Exception ex) { Log.Error(ex, "Heartbeat: publish loop stopped."); }
    }

    private void OnMessageReceived(object? sender, OnMessageReceivedEventArgs e)
    {
        try
        {
            var json = e.PublishMessage.PayloadAsString;
            var topicId = e.PublishMessage.Topic?.Split('/').LastOrDefault();
            if (string.IsNullOrEmpty(json)) { if (!string.IsNullOrEmpty(topicId)) seen.TryRemove(topicId, out _); return; } // empty retained = tombstone
            var beat = JsonSerializer.Deserialize<Heartbeat>(json, Json);
            if (beat is not null && !string.IsNullOrEmpty(beat.Id)) seen[beat.Id] = beat;
        }
        catch (Exception ex) { Log.Warning($"Heartbeat: could not read one from '{e.PublishMessage.Topic}': {ex.Message}"); }
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        cts.Cancel();
        if (pump is not null)
            try { await pump; } catch { /* ignore shutdown races */ }
        mqtt.OnMessageReceived -= OnMessageReceived;
        // Clear our retained heartbeat so we disappear from other processes promptly on a clean stop.
        try { await mqtt.PublishAsync(new MQTT5PublishMessage(TopicFor(self.Id), QualityOfService.AtLeastOnceDelivery) { PayloadAsString = "", Retain = true }); }
        catch { /* best effort */ }
    }
}
