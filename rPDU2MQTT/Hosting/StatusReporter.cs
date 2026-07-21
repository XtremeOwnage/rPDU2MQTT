using HiveMQtt.Client;
using Microsoft.Extensions.Hosting;
using Orleans;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core;
using rPDU2MQTT.Grains.Abstractions.Status;
using rPDU2MQTT.Services;

namespace rPDU2MQTT.Hosting;

/// <summary>
/// Reports what this process can see of each Status-board component to that component's grain (v3). It states
/// facts only — connected or not, when the last poll landed, what the last export returned, what's configured
/// — and never decides what they mean; the component grains own that, so every replica and every reader agree.
/// <para>
/// Registered in every process: several may report the same component (they're all talking to the same
/// broker), and the component grain reconciles.
/// </para>
/// </summary>
public sealed class StatusReporter : BackgroundService
{
    private readonly IGrainFactory grains;
    private readonly Config config;
    private readonly IHiveMQClient mqtt;
    private readonly ISnapshotCache snapshots;
    private readonly EmonCmsStatus emon;
    private readonly ProcessIdentity self;

    public StatusReporter(IGrainFactory grains, Config config, IHiveMQClient mqtt, ISnapshotCache snapshots, EmonCmsStatus emon, ProcessIdentity self)
    {
        this.grains = grains;
        this.config = config;
        this.mqtt = mqtt;
        this.snapshots = snapshots;
        this.emon = emon;
        this.self = self;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try { await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken); } catch (OperationCanceledException) { return; }

        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(10));
        do
        {
            try { await ReportAsync(); }
            catch (Exception ex) { Serilog.Log.Debug($"Status reporter: {ex.Message}"); }
        }
        while (await SafeWait(timer, stoppingToken));
    }

    private async Task ReportAsync()
    {
        await grains.GetGrain<IMqttStatusGrain>("mqtt").Report(new ComponentReport
        {
            Ok = mqtt.IsConnected(),
            Detail = $"{mqtt.Options.Host}:{mqtt.Options.Port}",
        });

        // One card per PDU instance, judged against that instance's own poll cadence. Driven by config, not
        // just by what has arrived — a configured PDU that has never polled has to show up as waiting.
        var latest = snapshots.All.ToDictionary(s => s.InstanceId, StringComparer.OrdinalIgnoreCase);
        foreach (var id in config.Pdus.Keys.Union(latest.Keys, StringComparer.OrdinalIgnoreCase))
            await grains.GetGrain<IPduStatusGrain>($"pdu:{id}").Report(new ComponentReport
            {
                Title = $"PDU · {id}",
                EventUtc = latest.TryGetValue(id, out var s) ? s.TimestampUtc : null,
                IntervalSeconds = config.Pdus.TryGetValue(id, out var pc) ? pc.PollInterval : 30,
                Detail = "Waiting for the first poll",
            });

        // Only the process running the exporter has an outcome; the others report the config and leave Ok
        // null, which the grain treats as "no news" rather than "no export".
        var e = emon.Snapshot();
        var attempted = emon.HasAttempted;
        await grains.GetGrain<IEmonCmsStatusGrain>("emoncms").Report(new ComponentReport
        {
            Enabled = config.EmonCMS.Enabled,
            Ok = attempted ? e.Ok : null,
            Count = attempted ? e.Count : 0,
            EventUtc = e.LastSuccessUtc,
            Detail = attempted && e.Ok == false
                ? e.LastError
                : config.EmonCMS.Transport.ToString().ToUpperInvariant(),
        });

        await grains.GetGrain<IHomeAssistantStatusGrain>("homeassistant").Report(new ComponentReport
        {
            Enabled = config.HASS.DiscoveryEnabled,
            Detail = $"Topic: {(string.IsNullOrWhiteSpace(config.HASS.DiscoveryTopic) ? "—" : config.HASS.DiscoveryTopic)}",
        });

        await grains.GetGrain<IPrometheusStatusGrain>("prometheus").Report(new ComponentReport
        {
            Enabled = config.Prometheus.Exporter,
            Detail = $":{config.Prometheus.Port}/metrics",
        });

        // This process. Its silence is what tells the board a replica has gone.
        await grains.GetGrain<INodeStatusGrain>($"node:{self.Id}").Report(new ComponentReport
        {
            Title = $"Node · {self.Host}",
            State = self.RoleLabel,
            Detail = $"v{self.Version} ·",
            EventUtc = self.StartedUtc,
        });
    }

    private static async Task<bool> SafeWait(PeriodicTimer timer, CancellationToken ct)
    {
        try { return await timer.WaitForNextTickAsync(ct); }
        catch (OperationCanceledException) { return false; }
    }
}
