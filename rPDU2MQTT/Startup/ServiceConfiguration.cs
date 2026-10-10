using HiveMQtt.Client;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core;
using rPDU2MQTT.Helpers;
using rPDU2MQTT.Services;
using rPDU2MQTT.Services.Kubernetes;
using rPDU2MQTT.Startup.ConfigSources;

namespace rPDU2MQTT.Startup;

public static class ServiceConfiguration
{
    /// <summary>Config sections contributed by externally loaded plugins.</summary>
    public static IReadOnlyList<(string Id, string Label, Type ConfigType, string? Group)> PluginSections { get; private set; }
        = Array.Empty<(string, string, Type, string?)>();

    /// <summary>Settings externally loaded plugins keep on core entities.</summary>
    public static IReadOnlyList<Core.Integrations.EntityExtension> EntityExtensions { get; private set; } = [];

    public static void Configure(HostBuilderContext context, IServiceCollection services)
    {
        IConfigSource configSource = ConfigSourceFactory.IsKubernetes
            ? new KubernetesConfigSource()
            : new FileConfigSource();
        Log.Information($"Loading configuration from {configSource.Describe}.");

        Config cfg = configSource.Load() ?? throw new Exception("Unable to load configuration");

        // Only hosted services are gated by role; singletons are always registered.
        var roles = HostRoles.Resolve(context.Configuration);
        services.AddSingleton(typeof(HostRole), roles);
        Log.Information($"Active host role(s): {roles}.");
        bool worker = roles.HasFlag(HostRole.Worker);
        bool api = roles.HasFlag(HostRole.Api);
        bool ui = roles.HasFlag(HostRole.Ui);

        // With a leader lease a worker starts as standby and leads only while it holds the lease.
        var leaseConnection = cfg.Cache.Enabled ? null : Environment.GetEnvironmentVariable(Services.LeaderLeaseService.ConnectionVariable);
        var leaderLease = worker && Services.LeaderLeaseService.Requested;
        if (leaderLease && !cfg.Cache.Enabled && string.IsNullOrWhiteSpace(leaseConnection))
        {
            Log.Error($"{Services.LeaderLeaseService.EnableVariable} is set, but Cache is not enabled: the lease has nowhere to be "
                    + "kept, so this process leads on its own. A second process started beside it would poll and "
                    + "publish as well. Enable the Cache, or deploy with a Recreate strategy.");
            leaderLease = false;
        }
        services.AddSingleton(new LeaderState { IsLeader = worker && !leaderLease, Coordinated = leaderLease });

        services.AddSingleton(cfg);
        services.AddSingleton(configSource);
        if (configSource is KubernetesConfigSource k8sSource)
        {
            services.AddSingleton(k8sSource);
            services.AddHostedService<KubernetesStatusService>();
            services.AddHostedService<KubernetesConfigWatcher>();

            services.AddSingleton<Services.Operator.IContainerRegistry, Services.Operator.ContainerRegistryClient>();
            services.AddSingleton<Core.Operator.IOperatorControl, Hosting.KubernetesOperator>();
            if (worker)
                services.AddHostedService<Hosting.OperatorUpdateCheck>();
        }

        services.ConfigureLogging(cfg);

        services.AddSingleton<IHiveMQClient, HiveMQClient>((sp) => new HiveMQClient(MqttOptionsFactory.Build(cfg)));

        // Re-points the live client when broker or credentials change.
        services.AddSingleton<Services.MqttReconfigurator>();

        // Instantiated explicitly in Program.cs before the initial connect.
        services.AddSingleton(sp => new MqttEventHandler((HiveMQClient)sp.GetRequiredService<IHiveMQClient>()));


        services.AddSingleton<MQTTServiceDependencies>();

        services.AddSingleton<Core.IMessageBus, Core.ChannelMessageBus>();
        services.AddSingleton<Core.SnapshotCache>();
        services.AddSingleton<Core.ISnapshotCache>(sp => sp.GetRequiredService<Core.SnapshotCache>());
        // Non-worker nodes also drain the bus to fill their cache from the worker's snapshots.
        if (worker || api || ui)
        {
            services.AddHostedService(sp => sp.GetRequiredService<Core.SnapshotCache>());
        }
        services.AddSingleton<HealthState>();
        services.AddSingleton<Core.RestartPending>();
        var faults = new Core.Startup.ConfigurationFaults();
        services.AddSingleton(faults);


        services.AddSingleton<DiscoveryCoordinator>();

        services.AddSingleton<Services.HaEnergyDashboardSync>();

        // Live values written directly by in-process sources.
        var liveValues = new Core.Flow.FlowValueCache();

        services.AddSingleton<Abstractions.Pipeline.ISnapshotSink<Abstractions.Flow.MeasurementSnapshot>>(sp =>
            new Core.Flow.FlowValueSink(liveValues, sp.GetService<Microsoft.Extensions.Logging.ILogger<Core.Flow.FlowValueSink>>()));
        services.AddSingleton<Abstractions.Pdu.IOutletControl, Services.DeviceOutletControl>();
        services.AddSingleton<Services.EnergyFlowMqttSourceService>();
        if (worker)
            services.AddHostedService(sp => sp.GetRequiredService<Services.EnergyFlowMqttSourceService>());

        // Modbus polls only on the worker; many gateways accept a single TCP client.
        services.AddSingleton<Services.EnergyFlowModbusSourceService>();
        // One poll per physical device (host:port:unitId).
        services.AddSingleton<Core.Modbus.ModbusDevices>();
        if (worker)
            services.AddHostedService<Services.ModbusPollService>();

        // Externally loaded plugins; one that fails to load is reported and skipped.
        var plugins = Plugins.PluginLoader.LoadAll(cfg.DisabledPlugins, m => Log.Information(m));
        services.AddSingleton(new Plugins.PluginCatalog(plugins));
        var pluginIntegrations = plugins.SelectMany(p => p.Integrations).ToList();
        var pluginHost = new Plugins.PluginHost(cfg);
        services.AddSingleton(pluginHost);
        if (pluginIntegrations.Count > 0)
        {
            Plugins.PluginLoader.Configure(pluginIntegrations, cfg, m => Log.Warning(m));
            foreach (var user in pluginIntegrations.OfType<Core.Integrations.IPluginHostUser>()) user.UseHost(pluginHost);
            foreach (var integration in pluginIntegrations)
                services.AddSingleton(typeof(Core.Integrations.IIntegration), integration);
        }
        AddCache(services, cfg, pluginIntegrations.OfType<Core.History.IHistoryBackend>().ToList());
        PluginSections = Plugins.PluginLoader.Sections(pluginIntegrations).ToList();
        EntityExtensions = Core.Integrations.EntityExtensions.Of(pluginIntegrations).ToList();
        // Tiers and areas plugins add, such as a total per room.
        services.AddSingleton(new Core.Integrations.ExportContributions(pluginIntegrations));
        // Plugin source types offered in the node editor.
        Services.Gui.ConfigSchema.PluginSourceTypes = pluginIntegrations
            .OfType<Core.Integrations.IValueSourcePlugin>()
            .Select(p => (p.SourceType, p.SourceTypeLabel))
            .ToList();

        // Built-in sources are constructed once and registered as that same instance.
        var haSource = new Integrations.HomeAssistant.HomeAssistantValueSource(cfg);
        services.AddSingleton<Core.Integrations.IIntegration>(haSource);
        // The built-in ingests as integrations, using the same instances the flow reads.
        services.AddSingleton<Core.Integrations.IIntegration>(sp => sp.GetRequiredService<Services.EnergyFlowMqttSourceService>());
        services.AddSingleton<Core.Integrations.IIntegration>(sp => sp.GetRequiredService<Services.EnergyFlowModbusSourceService>());

        var pluginSources = pluginIntegrations.OfType<Core.Integrations.IValueSourcePlugin>()
            .Cast<Core.Flow.IFlowValueSource>()
            .ToArray();

        var aggregationOn = cfg.EnergyFlow.Aggregation.Enabled;
        var periodsOn = cfg.EnergyFlow.Aggregation.TrackPeriods;
        if (aggregationOn || periodsOn)
        {
            services.AddSingleton(sp => new Services.EnergyAggregationService(
                cfg,
                new Core.Flow.CompositeFlowValueSource(
                    [sp.GetRequiredService<Services.EnergyFlowMqttSourceService>(), liveValues, haSource, .. pluginSources]),
                sp.GetRequiredService<Core.Flow.IEnergyStore>(),
                sp.GetRequiredService<Core.ISnapshotCache>(),
                sp.GetService<LeaderState>()));
            // Only the worker accumulates; other roles read the store.
            if (worker)
                services.AddHostedService(sp => sp.GetRequiredService<Services.EnergyAggregationService>());
            else if (api || ui)
                services.AddHostedService(sp => new Services.EnergyStoreReaderService(
                    cfg, sp.GetRequiredService<Services.EnergyAggregationService>()));
        }

        // Derived values wrap the whole composite so a measured reading still wins.
        services.AddSingleton<Core.Flow.IFlowValueSource>(sp => new Core.Flow.DerivedFlowValueSource(
            aggregationOn || periodsOn
            ? new Core.Flow.CompositeFlowValueSource(
                [sp.GetRequiredService<Services.EnergyFlowMqttSourceService>(),
                liveValues,
                haSource,
                .. pluginSources,
                // Derived totals and history last: the composite takes the first fresh reading.
                sp.GetRequiredService<Services.EnergyAggregationService>(),
                .. (cfg.History.Enabled && cfg.History.ValueFallback
                    ? new Core.Flow.IFlowValueSource[] { sp.GetRequiredService<Core.Flow.HistoryValueSource>() }
                    : [])])
            : new Core.Flow.CompositeFlowValueSource(
                [sp.GetRequiredService<Services.EnergyFlowMqttSourceService>(), liveValues,
                 haSource, .. pluginSources,
                 .. (cfg.History.Enabled && cfg.History.ValueFallback
                     ? new Core.Flow.IFlowValueSource[] { sp.GetRequiredService<Core.Flow.HistoryValueSource>() }
                     : [])]), cfg));

        if (worker)
            services.AddHostedService<Services.ValueSourcePluginHost>();

        if (cfg.History.Enabled && cfg.History.ValueFallback)
            services.AddSingleton(sp => new Core.Flow.HistoryValueSource(
                sp.GetRequiredService<Core.Flow.IMeasurementHistory>(), cfg,
                () => cfg.EnergyFlow.Nodes.Select(n => n.Id).Where(id => !string.IsNullOrEmpty(id)).ToList()));

        if (cfg.History.Enabled && cfg.History.ValueFallback)
            services.AddHostedService<Services.HistoryValueSourceService>();

        // PDU instances come from a plugin (Vertiv); none when it isn't loaded.
        var pduProvider = pluginIntegrations.OfType<Core.Integrations.IPduInstanceProvider>().FirstOrDefault();
        services.AddSingleton(sp => pduProvider?.Attach(cfg, sp.GetRequiredService<Core.ISnapshotCache>())
            ?? new Core.Integrations.PduAttachment(new Core.Integrations.NoPduInstances(), null));
        services.AddSingleton(sp => sp.GetRequiredService<Core.Integrations.PduAttachment>().Instances);
        if (pduProvider is not null)
            services.AddSingleton(sp => sp.GetRequiredService<Core.Integrations.PduAttachment>().Reader!);

        // Device plugins are driven by the same poller as the built-in reader.
        var devicePlugins = pluginIntegrations.OfType<Core.Integrations.IDeviceSourcePlugin>().ToList();
        if (devicePlugins.Count > 0)
            services.AddSingleton<Core.Integrations.IDeviceReader>(new Core.Integrations.PluginDeviceReader(devicePlugins));

        // Built-in integrations, discovered by reflection over the Engine assembly.
        foreach (var type in typeof(Services.DestinationHost).Assembly.GetTypes()
                     .Where(t => t is { IsClass: true, IsAbstract: false })
                     .Where(t => typeof(Core.Integrations.IIntegration).IsAssignableFrom(t))
                     // Value sources are registered explicitly above.
                     .Where(t => !typeof(Core.Flow.IFlowValueSource).IsAssignableFrom(t)))
            services.AddSingleton(typeof(Core.Integrations.IIntegration), type);

        services.AddSingleton(new Services.Gui.PluginSchemaSections(PluginSections, EntityExtensions));

        // Hands the cluster lease and the plugin store to integrations that ask for them.
        services.AddSingleton(sp =>
        {
            pluginHost.Attach(sp);
            var registry = new Core.Integrations.IntegrationRegistry(sp.GetServices<Core.Integrations.IIntegration>());
            var lease = sp.GetRequiredService<Core.Integrations.ISingleOwnerLease>();
            foreach (var user in registry.All.OfType<Core.Integrations.ISingleOwnerLeaseUser>()) user.UseLease(lease);
            var cache = sp.GetService<Services.ICacheClient>();
            foreach (var user in registry.All.OfType<Core.Integrations.IPluginStoreUser>())
                user.UseStore(cache is null ? new Core.Integrations.NullPluginStore()
                    : new Services.CachePluginStore(cache, cfg.Cache.KeyPrefix, ((Core.Integrations.IIntegration)user).Id, m => Log.Warning(m)));
            return registry;
        });
        // Records enabled-but-unrunnable integrations into the shared faults collection.
        services.AddHostedService<Hosting.IntegrationFaultReporter>();
        services.AddSingleton<Core.Integrations.IMessagePublisher, Services.MqttMessagePublisher>();
        services.AddSingleton<Core.Integrations.IBrokerConnection, Services.HiveMqBrokerConnection>();

        services.AddSingleton<Core.Integrations.INodeProvider, Hosting.MqttNodeProvider>();
        services.AddSingleton<Core.Integrations.INodeProvider, Hosting.ModbusNodeProvider>();

        if (worker)
            services.AddHostedService<Services.DevicePollService>();

        services.AddSingleton<Services.MqttPduPublisher>();
        services.AddSingleton<Core.Integrations.IntegrationStatus>();
        services.AddSingleton<Core.Status.StatusBoard>();
        services.AddSingleton<Core.Discovery.TopicIndex>();
        services.AddSingleton<Core.Diagnostics.ProcessRegistry>();
        // With a leader lease every key belongs to the leader.
        if (leaderLease)
            services.AddSingleton<Core.Integrations.ISingleOwnerLease>(sp => new Core.Integrations.LeaderGatedLease(sp.GetRequiredService<LeaderState>()));
        else
            services.AddSingleton<Core.Integrations.ISingleOwnerLease, Core.Integrations.SoleOwnerLease>();

        services.AddSingleton<Hosting.ProcessIdentity>();

        // Under Kubernetes restart by replacing the pod; elsewhere stop with a non-zero exit code.
        services.AddSingleton<Hosting.StopProcessRestarter>();
        if (configSource is KubernetesConfigSource)
            services.AddSingleton<Core.IProcessRestarter>(sp => new Hosting.KubernetesPodRestarter(
                (KubernetesConfigSource)sp.GetRequiredService<IConfigSource>(),
                sp.GetRequiredService<Hosting.StopProcessRestarter>()));
        else
            services.AddSingleton<Core.IProcessRestarter>(sp => sp.GetRequiredService<Hosting.StopProcessRestarter>());

        // Lets the GUI list every role process in a split deployment.
        if (roles != HostRole.All)
            services.AddHostedService<Hosting.ProcessRegistrar>();

        services.AddHostedService<Hosting.StatusReporter>();

        // Subscribes only while someone is browsing topics.
        services.AddHostedService<Hosting.MqttTopicIndexService>();

        services.AddHostedService<Services.RestartCommandService>();

        // ---- Worker role ----
        if (worker)
        {

            // Destinations self-gate on Enabled(cfg) each pass.
            services.AddHostedService<DestinationHost>();
            // Configuration publishers run on their own slower cadence.
            services.AddHostedService<ConfigurationPublisherHost>();

            // Self-gates on the live HomeAssistant.DiscoveryEnabled toggle.
            services.AddHostedService<HomeAssistantDiscoveryService>();
            services.AddHostedService<DiagnosticService>();
            if (!cfg.HASS.DiscoveryEnabled)
                Log.Warning("Home Assistant discovery is off. Turning it on in the GUI takes effect on the next pass; no restart needed.");

            if (cfg.Primary.ActionsEnabled)
            {
                if (string.IsNullOrEmpty(cfg.Primary.Credentials?.Username) || string.IsNullOrEmpty(cfg.Primary.Credentials?.Password))
                    Log.Warning("PDU.ActionsEnabled is true, but PDU credentials are not set. Outlet on/off control will fail until Pdu.Credentials (or RPDU2MQTT_PDU_USERNAME / RPDU2MQTT_PDU_PASSWORD) are provided.");

                Log.Information("Outlet control is ENABLED (ActionsEnabled).");
                services.AddHostedService<OutletCommandService>();
            }
        }

        if (cfg.Health.Enabled)
            services.AddHostedService<HealthService>();

        // ---- Api role ----
        if (api && cfg.Api.Enabled)
            services.AddHostedService<ApiService>();

        // ---- Ui role ----
        if (ui && cfg.Gui.Enabled)
            services.AddHostedService<Services.Gui.GuiService>();

        // Stopped before the web hosts so they keep answering while the gateway stops routing here.
        if (leaderLease)
            services.AddHostedService<Services.ShutdownDrainService>();

        // Last, so it is stopped first.
        if (leaderLease)
            services.AddHostedService(sp => new Services.LeaderLeaseService(
                string.IsNullOrWhiteSpace(leaseConnection)
                    ? sp.GetRequiredService<Services.RedisCacheClient>()
                    : new Services.RedisCacheClient(new Models.Config.CacheConfig
                    {
                        Connection = leaseConnection, Password = cfg.Cache.Password,
                        ConnectTimeoutSeconds = cfg.Cache.ConnectTimeoutSeconds,
                    }, new Core.Flow.CacheHealth()),
                sp.GetRequiredService<LeaderState>(), sp.GetRequiredService<IHiveMQClient>(), cfg.Cache.KeyPrefix));
    }

    /// <summary>Registers the history store, router, copy service and writer.</summary>
    /// <param name="backends">History backends contributed by plugins.</param>
    public static void AddHistory(IServiceCollection services, Config cfg, IReadOnlyList<Core.History.IHistoryBackend>? backends = null)
    {
        backends ??= [];
        var historyPath = !string.IsNullOrWhiteSpace(cfg.History.LocalPath) ? cfg.History.LocalPath
            : Environment.GetEnvironmentVariable("RPDU2MQTT_HISTORY_DIRECTORY") is { Length: > 0 } mounted ? mounted
            : Path.Combine(AppContext.BaseDirectory, "history");
        services.AddSingleton(_ => new Core.History.LocalSeriesStore(
            historyPath,
            rawIntervalSeconds: cfg.EnergyFlow.Aggregation.SampleIntervalSeconds,
            toleranceSeconds: cfg.History.ToleranceSeconds,
            rawKeepDays: cfg.History.LocalRawKeepDays,
            minuteKeepDays: cfg.History.LocalMinuteKeepDays,
            hourKeepDays: cfg.History.LocalHourKeepDays,
            dayKeepDays: cfg.History.LocalDayKeepDays));
        // Short timeout so a dashboard read cannot hang on a slow backend.
        services.AddSingleton<Core.Flow.IMeasurementHistory>(sp =>
            new Services.FlowHistoryRouter(new HttpClient { Timeout = TimeSpan.FromSeconds(10) }, cfg,
                                           sp.GetRequiredService<Core.History.LocalSeriesStore>(), backends));
        // Copies read weeks at a time, so use a longer timeout.
        services.AddSingleton(sp =>
        {
            var store = sp.GetRequiredService<Core.History.LocalSeriesStore>();
            var slow = new HttpClient { Timeout = TimeSpan.FromMinutes(2) };
            return new Services.HistoryCopyService(cfg, new Services.FlowHistoryRouter(slow, cfg, store, backends).Backends,
                [new Integrations.Local.LocalHistoryTarget(cfg, store),
                 .. backends.Select(b => b.CreateHistoryTarget(slow, cfg)).OfType<Core.History.IHistoryTarget>()],
                store, sp.GetRequiredService<Core.Flow.IFlowValueSource>(),
                sp.GetService<Core.ISnapshotCache>(), sp.GetService<LeaderState>(),
                backends.ToDictionary(b => b.HistoryId, b => (Func<string?>)(() => b.HistoryUnavailable(cfg)), StringComparer.OrdinalIgnoreCase));
        });
        services.AddHostedService(sp => new Services.LocalHistoryWriterService(
            cfg, sp.GetRequiredService<Core.Flow.IFlowValueSource>(),
            sp.GetRequiredService<Core.History.LocalSeriesStore>(),
            sp.GetService<Core.ISnapshotCache>(),
            sp.GetService<LeaderState>()));
    }

    public static void AddCache(IServiceCollection services, Config cfg, IReadOnlyList<Core.History.IHistoryBackend>? historyBackends = null)
    {
        AddHistory(services, cfg, historyBackends);

        services.AddSingleton<Core.Flow.IPeriodAuditor>(sp =>
        {
            // Only the leader persists verdicts; a newly promoted leader reloads them.
            var leader = sp.GetService<LeaderState>();
            var auditor = new Core.Flow.PeriodAuditor(sp.GetRequiredService<Core.Flow.IPeriodAuditStore>(),
                                                      mayPersist: leader is null ? null : () => leader.IsLeader);
            if (leader is not null) leader.Promoted += auditor.Reload;
            return auditor;
        });

        services.AddSingleton<Core.Flow.CacheHealth>();
        if (cfg.Cache.Enabled)
        {
            // Constructed explicitly: only the whole Config is registered, not CacheConfig.
            services.AddSingleton(sp => new Services.RedisCacheClient(cfg.Cache, sp.GetRequiredService<Core.Flow.CacheHealth>()));
            services.AddSingleton<Services.ICacheClient>(sp => sp.GetRequiredService<Services.RedisCacheClient>());
            services.AddSingleton<Core.Flow.IEnergyStore>(sp => new Services.RedisEnergyStore(
                sp.GetRequiredService<Services.ICacheClient>(), cfg.Cache.KeyPrefix, m => Log.Warning(m)));
            services.AddSingleton<Core.Flow.IPeriodAuditStore>(sp => new Services.RedisPeriodAuditStore(
                sp.GetRequiredService<Services.ICacheClient>(), cfg.Cache.KeyPrefix, m => Log.Warning(m)));
            services.AddSingleton<Core.Plans.IPlanImageStore>(sp => new Services.CachePlanImageStore(
                sp.GetRequiredService<Services.ICacheClient>(), cfg.Cache.KeyPrefix));
        }
        else
        {
            // Local file store: survives restarts but is not shared between replicas.
            services.AddSingleton<Core.Flow.IEnergyStore>(_ => new Core.Flow.FileEnergyStore(
                Path.Combine(AppContext.BaseDirectory, "energy-totals.json"), m => Log.Warning(m)));
            services.AddSingleton<Core.Flow.IPeriodAuditStore>(_ => new Core.Flow.FilePeriodAuditStore(
                Path.Combine(AppContext.BaseDirectory, "period-audit.json"), m => Log.Warning(m)));
        }
    }
}
