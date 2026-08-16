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
    // Every integration this build carries, and what each last did — so the board needs no per-integration branch.
    private readonly Core.Integrations.IntegrationRegistry? registry;
    private readonly Core.Integrations.IntegrationStatus? integrationStatus;
    private readonly IHiveMQClient mqtt;
    private readonly ISnapshotCache snapshots;
    private readonly EmonCmsStatus emon;
    private readonly ProcessIdentity self;
    private readonly Core.Flow.CacheHealth? cacheHealth;
    private readonly Core.Startup.ConfigurationFaults? faults;
    private readonly Services.ICacheClient? cacheProbe;
    private readonly Core.Flow.IMeasurementHistory? history;

    public StatusReporter(IGrainFactory grains, Config config, IHiveMQClient mqtt, ISnapshotCache snapshots, EmonCmsStatus emon, ProcessIdentity self, Core.Flow.CacheHealth? cacheHealth = null, Core.Startup.ConfigurationFaults? faults = null, Services.ICacheClient? cacheProbe = null, Core.Flow.IMeasurementHistory? history = null, Core.Integrations.IntegrationRegistry? registry = null, Core.Integrations.IntegrationStatus? integrationStatus = null)
    {
        this.grains = grains;
        this.config = config;
        this.registry = registry;
        this.integrationStatus = integrationStatus;
        this.mqtt = mqtt;
        this.snapshots = snapshots;
        this.emon = emon;
        this.self = self;
        this.cacheHealth = cacheHealth;
        this.faults = faults;
        this.cacheProbe = cacheProbe;
        this.history = history;
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
        while (await Core.Ticks.Next(timer, stoppingToken));
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

        // The three destination cards below used to be branches here, each with its own idea of what
        // "amber" meant. The verdict now comes from the integration itself (IStatusProvider), so the rule
        // lives with the thing it is about and a plugin gets the same treatment as a built-in.
        await ReportIntegration<IEmonCmsStatusGrain>("emoncms");
        await ReportIntegration<IHomeAssistantStatusGrain>("homeassistant");
        await ReportIntegration<IPrometheusStatusGrain>("prometheus");

        // Every integration that has no hand-written component grain — each loaded plugin, and any
        // built-in that never needed one. Reported from the registry rather than a branch per integration,
        // so an integration cannot be running and yet absent from the board.
        var bespoke = new HashSet<string>(["mqtt", "emoncms", "homeassistant", "prometheus"], StringComparer.OrdinalIgnoreCase);
        foreach (var integration in registry?.All ?? [])
        {
            if (bespoke.Contains(integration.Id)) continue;

            // The integration's own verdict where it has one (IStatusProvider), the shared derivation
            // otherwise — never a rule invented here, which is where a per-integration branch used to live.
            var last = integrationStatus?.For(integration.Id);
            var health = Core.Integrations.IntegrationHealthDefaults.For(integration, config, last);
            await grains.GetGrain<IIntegrationStatusGrain>(integration.Id).Report(new ComponentReport
            {
                Title = integration.DisplayName,
                Enabled = health.Level != Core.Integrations.HealthLevel.Off,
                Ok = health.Level switch
                {
                    Core.Integrations.HealthLevel.Good => true,
                    Core.Integrations.HealthLevel.Bad => false,
                    _ => (bool?)null,
                },
                Count = last?.Count ?? 0,
                EventUtc = last?.LastSuccessUtc,
                Detail = health.Detail ?? health.Summary,
            });
        }

        // The shared cache. Ok comes from a real round-trip via the store, not from the config claiming it
        // should work — "configured but unreachable" is precisely the state worth surfacing, because the
        // bridge keeps running on local state and the energy counters quietly stop being shared.
        // Probe rather than wait for traffic. Energy aggregation is off by default, so nothing else
        // touches the cache — the card previously reported "unreachable" for a perfectly healthy instance
        // simply because nothing had used it yet.
        if (config.Cache.Enabled) cacheProbe?.Ping();
        await grains.GetGrain<ICacheStatusGrain>("cache").Report(new ComponentReport
        {
            Enabled = config.Cache.Enabled,
            Ok = config.Cache.Enabled ? (cacheHealth?.Attempted == true ? cacheHealth.Reachable : null) : null,
            Detail = config.Cache.Enabled
                ? (cacheHealth?.Reachable == false ? (cacheHealth.Error ?? "no connection") : config.Cache.Connection)
                : "Energy totals kept in a local file",
        });

        // The history backend, probed for the same reason the cache is: the pages look entirely normal
        // until someone picks a date and gets nothing back.
        var historyOk = history is null ? (bool?)null : null;
        var historyDetail = config.History.Enabled ? config.History.Provider : "Flow and Energy show live values only";
        if (config.History.Enabled && history is not null)
        {
            try
            {
                var probe = await history.ProbeAsync(CancellationToken.None);
                historyOk = probe.Ok;
                historyDetail = $"{history.Id} · {probe.Detail}";
            }
            catch (Exception ex) { historyOk = false; historyDetail = ex.Message; }
        }
        await grains.GetGrain<IHistoryStatusGrain>("history").Report(new ComponentReport
        {
            Enabled = config.History.Enabled,
            Ok = config.History.Enabled ? historyOk : null,
            State = history?.Id,
            Detail = historyDetail,
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
    /// <summary>
    /// Report one integration's own verdict to its component grain. The grain keeps whatever cross-process
    /// judgement it has — EmonCMS still refuses to let an outcome-free report overwrite a known one, which
    /// is about who is reporting rather than about what healthy means.
    /// </summary>
    private async Task ReportIntegration<TGrain>(string id) where TGrain : IComponentStatusGrain
    {
        if (registry?.ById(id) is not { } integration) return;

        var last = integrationStatus?.For(id);
        var health = Core.Integrations.IntegrationHealthDefaults.For(integration, config, last);
        await grains.GetGrain<TGrain>(id).Report(new ComponentReport
        {
            Title = integration.DisplayName,
            Enabled = health.Level != Core.Integrations.HealthLevel.Off,
            Ok = health.Level switch
            {
                Core.Integrations.HealthLevel.Good => true,
                Core.Integrations.HealthLevel.Bad => false,
                _ => (bool?)null,
            },
            Count = last?.Count ?? 0,
            EventUtc = last?.LastSuccessUtc,
            Detail = health.Detail ?? health.Summary,
        });
    }

}
