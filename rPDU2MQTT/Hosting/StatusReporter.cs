using HiveMQtt.Client;
using Microsoft.Extensions.Hosting;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core;
using rPDU2MQTT.Core.Status;
using Kind = rPDU2MQTT.Core.Status.StatusBoard.ComponentKind;
using rPDU2MQTT.Services;

namespace rPDU2MQTT.Hosting;

/// <summary>
/// Reports what this process can see of each Status-board component: connected or not, when the last poll
/// landed, what the last export returned, what is configured. It states facts only and never decides what
/// they mean — <see cref="StatusBoard"/> owns that, so every card is judged by one rule.
/// </summary>
public sealed class StatusReporter : BackgroundService
{
    private readonly Config config;
    // Every integration this build carries, and what each last did — so the board needs no per-integration branch.
    private readonly Core.Status.StatusBoard board;
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
    private readonly LeaderState? leader;
    private readonly Core.History.LocalSeriesStore? localHistory;
    // Checking a directory means writing a probe file into it, so it is done once a minute, not per tick.
    private IReadOnlyList<Core.StorageUse>? storage;
    private DateTime storageCheckedUtc = DateTime.MinValue;

    public StatusReporter(Config config, IHiveMQClient mqtt, ISnapshotCache snapshots, EmonCmsStatus emon, ProcessIdentity self, Core.Flow.CacheHealth? cacheHealth = null, Core.Startup.ConfigurationFaults? faults = null, Services.ICacheClient? cacheProbe = null, Core.Flow.IMeasurementHistory? history = null, Core.Integrations.IntegrationRegistry? registry = null, Core.Integrations.IntegrationStatus? integrationStatus = null, Core.Status.StatusBoard? statusBoard = null, Core.History.LocalSeriesStore? localHistory = null, LeaderState? leader = null)
    {
        this.config = config;
        board = statusBoard ?? new Core.Status.StatusBoard();
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
        this.localHistory = localHistory;
        this.leader = leader;
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
        board.Report("mqtt", Kind.Broker, new ComponentReport
        {
            Ok = mqtt.IsConnected(),
            Detail = $"{mqtt.Options.Host}:{mqtt.Options.Port}",
        });

        // One card per PDU instance, judged against that instance's own poll cadence. Driven by config, not
        // just by what has arrived — a configured PDU that has never polled has to show up as waiting.
        var latest = snapshots.All.ToDictionary(s => s.InstanceId, StringComparer.OrdinalIgnoreCase);
        foreach (var id in config.Pdus.Keys.Union(latest.Keys, StringComparer.OrdinalIgnoreCase))
            board.Report($"pdu:{id}", Kind.Device, new ComponentReport
        {
                Title = $"PDU · {id}",
                EventUtc = latest.TryGetValue(id, out var s) ? s.TimestampUtc : null,
                IntervalSeconds = config.Pdus.TryGetValue(id, out var pc) ? pc.PollInterval : 30,
                Detail = "Waiting for the first poll",
            });

        // The three destination cards below used to be branches here, each with its own idea of what
        // "amber" meant. The verdict now comes from the integration itself (IStatusProvider), so the rule
        // lives with the thing it is about and a plugin gets the same treatment as a built-in.
        ReportIntegration("emoncms");
        ReportIntegration("homeassistant");
        ReportIntegration("prometheus");

        // Every integration that has no card reported above — each loaded plugin, and any built-in that
        // never needed one. Reported from the registry rather than a branch per integration,
        // so an integration cannot be running and yet absent from the board.
        var bespoke = new HashSet<string>(["mqtt", "emoncms", "homeassistant", "prometheus"], StringComparer.OrdinalIgnoreCase);
        foreach (var integration in registry?.All ?? [])
        {
            if (bespoke.Contains(integration.Id)) continue;

            // The integration's own verdict where it has one (IStatusProvider), the shared derivation
            // otherwise — never a rule invented here, which is where a per-integration branch used to live.
            var last = integrationStatus?.For(integration.Id);
            var health = Core.Integrations.IntegrationHealthDefaults.For(integration, config, last);
            board.Report(integration.Id, Kind.Integration, new ComponentReport
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
        board.Report("cache", Kind.Cache, new ComponentReport
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
        board.Report("history", Kind.History, new ComponentReport
        {
            Enabled = config.History.Enabled,
            Ok = config.History.Enabled ? historyOk : null,
            Title = history?.Id is { Length: > 0 } h ? $"History · {h}" : "History",
            Detail = historyDetail,
        });

        ReportStorage();

        // This process. Its silence is what tells the board a replica has gone.
        board.Report($"node:{self.Id}", Kind.Process, new ComponentReport
        {
            Title = $"Node · {self.Host}",
            // The role and version are what someone reads a node card FOR; the board derives the state.
            Detail = $"{self.RoleLabel}{LeaseRole()} · v{self.Version}",
            EventUtc = self.StartedUtc,
        });
    }
    /// <summary>
    /// The directories this process writes to, as one card judged by the one in the worst shape. A volume
    /// that did not mount, went read-only or filled up otherwise looks like readings quietly not being kept.
    /// </summary>
    private void ReportStorage()
    {
        if (storage is null || DateTime.UtcNow - storageCheckedUtc > TimeSpan.FromMinutes(1))
        {
            storage = Core.StorageUsage.Locations(config, localHistory?.Root, global::rPDU2MQTT.Plugins.PluginLoader.DefaultDirectory, count: false);
            storageCheckedUtc = DateTime.UtcNow;
        }

        var worst = Core.StorageUsage.Worst(storage);
        var state = worst is null ? Core.StorageState.Ok : Core.StorageUsage.StateOf(worst);
        board.Report("storage", Kind.Storage, new ComponentReport
        {
            Enabled = worst is not null,
            Ok = state is not (Core.StorageState.Missing or Core.StorageState.ReadOnly),
            Detail = worst is null ? "Nothing is written to disk by this process" : Core.StorageUsage.Describe(worst),
            // The tightest volume written to: the one that decides whether this is nearly full.
            FreeBytes = worst is { MustWrite: true } ? worst.FreeBytes : 0,
            TotalBytes = worst is { MustWrite: true } ? worst.TotalBytes : 0,
        });
    }

    /// <summary>Under a leader lease (#506), whether this node is the one producing, and why not.</summary>
    private string LeaseRole() => leader is not { Coordinated: true } ? ""
        : leader.IsLeader ? " · leader"
        : leader.StandbyReason is { } why ? $" · standby ({why})" : " · standby";

    /// <summary>
    /// Report one integration's own verdict. Its rule lives on the integration (IStatusProvider) or in the
    /// shared derivation — never here, which is where a branch per integration used to live.
    /// </summary>
    private void ReportIntegration(string id)
    {
        if (registry?.ById(id) is not { } integration) return;

        var last = integrationStatus?.For(id);
        var health = Core.Integrations.IntegrationHealthDefaults.For(integration, config, last);
        board.Report(id, Kind.Integration,
            StatusBoard.From(health, integration.DisplayName, last?.Count ?? 0, last?.LastSuccessUtc));
    }

}
