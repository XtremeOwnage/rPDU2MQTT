using Microsoft.Extensions.Hosting;
using Orleans;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core;
using rPDU2MQTT.Core.Transport;
using rPDU2MQTT.Grains.Abstractions.Pdu;

namespace rPDU2MQTT.Hosting;

/// <summary>
/// Publishes each PDU grain's latest snapshot onto this process's bus (v3), so the snapshot cache fills on
/// every process — worker, api, ui — straight from the grain. Replaces the MqttBusBridge that mirrored
/// snapshots over MQTT for split deployments.
/// </summary>
public sealed class PduSyncService : BackgroundService
{
    private readonly IGrainFactory grains;
    private readonly PduInstanceRegistry registry;
    // Device instances supplied by plugins, supervised by the same grain as a configured PDU.
    private readonly IReadOnlyList<string> pluginDevices;
    private readonly IMessageBus bus;
    private readonly HealthState health;
    private readonly Config config;
    // The freshest snapshot timestamp seen per instance — a repeat of the same one isn't a new poll.
    private readonly Dictionary<string, DateTime> seen = new(StringComparer.OrdinalIgnoreCase);

    public PduSyncService(IGrainFactory grains, PduInstanceRegistry registry, IMessageBus bus, HealthState health, Config config, IEnumerable<rPDU2MQTT.Core.Integrations.IDeviceReader>? readers = null)
    {
        this.grains = grains;
        this.registry = registry;
        pluginDevices = (readers ?? [])
            .OfType<rPDU2MQTT.Core.Integrations.PluginDeviceReader>()
            .SelectMany(r => r.InstanceIds)
            .ToList();
        this.bus = bus;
        this.health = health;
        this.config = config;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try { await Task.Delay(TimeSpan.FromSeconds(3), stoppingToken); } catch (OperationCanceledException) { return; }
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
        do
        {
            // Every device instance, not only the configured Vertiv ones: a plugin device is supervised by
            // the same grain, so its snapshot has to be collected from the same place or it polls into
            // nothing and every downstream consumer sees a device that is there and never reports.
            foreach (var id in registry.All.Keys.Concat(pluginDevices))
            {
                try
                {
                    var wire = await grains.GetGrain<IPduGrain>(id).Latest();
                    if (wire is null) continue;

                    // Rebuilding from the wire loses Record_Key/Record_Parent — they are [JsonIgnore] and the
                    // payload has no way to carry them. GetTopicPath() walks exactly that chain, so without
                    // this the snapshot that lands in the cache publishes every measurement to the bare topic
                    // `state`, and the good one the local poller put there is overwritten by it. On a live
                    // system that showed up as every Home Assistant sensor reading "Unavailable" while
                    // discovery — which builds its ids by another route — looked entirely healthy.
                    var data = RawSnapshotMapper.ToData(wire);
                    RawSnapshotMapper.Rewire(data, config.MQTT.ParentTopic,
                        string.IsNullOrWhiteSpace(config.Overrides?.rPDU2MQTT?.ID) ? "rPDU2MQTT" : config.Overrides!.rPDU2MQTT!.ID!);

                    await bus.PublishAsync(new PduSnapshot(wire.InstanceId, wire.TimestampUtc, data), stoppingToken);

                    // Readiness is a per-process signal read by this process's health endpoint, so it has to
                    // be recorded here — the poll itself happens in a grain on whichever silo owns it, and a
                    // process that never hosts that activation would otherwise report "no poll yet" forever.
                    // Only a genuinely newer snapshot counts; re-reading the same one is not a fresh poll.
                    if (!seen.TryGetValue(id, out var last) || wire.TimestampUtc > last)
                    {
                        seen[id] = wire.TimestampUtc;
                        health.RecordPollSuccess();
                    }
                }
                catch (Exception ex) { Serilog.Log.Debug($"PDU sync: {id} failed: {ex.Message}"); }
            }
        }
        while (await Core.Ticks.Next(timer, stoppingToken));
    }
}
