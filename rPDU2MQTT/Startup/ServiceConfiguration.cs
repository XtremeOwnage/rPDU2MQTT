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
    /// <summary>
    /// Config sections contributed by externally loaded plugins, resolved during registration so the
    /// schema endpoint can offer them. Static because the schema is served before the container is built.
    /// </summary>
    public static IReadOnlyList<(string Id, string Label, Type ConfigType, string? Group)> PluginSections { get; private set; }
        = Array.Empty<(string, string, Type, string?)>();

    public static void Configure(HostBuilderContext context, IServiceCollection services)
    {
        // While- we can request services when building dependencies-
        // Need the configuration DURING service collection initilization-
        // Because it determiens which hosted services we want to add.
        IConfigSource configSource = ConfigSourceFactory.IsKubernetes
            ? new KubernetesConfigSource()
            : new FileConfigSource();
        Log.Information($"Loading configuration from {configSource.Describe}.");

        Config cfg = configSource.Load() ?? throw new Exception("Unable to load configuration");

        // Which workload(s) this process runs. Default All = a single node that does everything. Singletons
        // (the object graph) are always registered; only the hosted services (the actual work) are gated by
        // role, so the default deployment is unchanged and a single role can be run per process to scale out.
        var roles = HostRoles.Resolve(context.Configuration);
        services.AddSingleton(typeof(HostRole), roles);
        Log.Information($"Active host role(s): {roles}.");
        bool worker = roles.HasFlag(HostRole.Worker);
        bool api = roles.HasFlag(HostRole.Api);
        bool ui = roles.HasFlag(HostRole.Ui);

        // One process, so it is always the leader. The flag stays because the gate is real — it is what
        // keeps run-once work run-once — and because a clustered implementation would set it from outside.
        services.AddSingleton(new LeaderState { IsLeader = true });

        // Bind Configuration + the source it came from (the GUI uses it to save).
        services.AddSingleton(cfg);
        services.AddSingleton(configSource);
        if (configSource is KubernetesConfigSource k8sSource)
        {
            services.AddSingleton(k8sSource);
            services.AddHostedService<KubernetesStatusService>();
            services.AddHostedService<KubernetesConfigWatcher>();

            // ---- Operator (#210) ----
            // GUI check/switch/redeploy call it directly — no MQTT command topics, no CR-status polling.
            services.AddSingleton<Services.Operator.IContainerRegistry, Services.Operator.ContainerRegistryClient>();
            services.AddSingleton<Core.Operator.IOperatorControl, Hosting.KubernetesOperator>();
            if (worker)
                services.AddHostedService<Hosting.OperatorUpdateCheck>();
        }

        // Configure Logging.
        services.ConfigureLogging(cfg);

        // Bind IHiveMQClient
        // Options are built by the shared factory so startup and the live re-point can't drift (#192).
        services.AddSingleton<IHiveMQClient, HiveMQClient>((sp) => new HiveMQClient(MqttOptionsFactory.Build(cfg)));

        // Re-points the live client when the broker/credentials change, instead of exiting to be restarted.
        services.AddSingleton<Services.MqttReconfigurator>();

        // Wires the client's connect/disconnect events and the online-status heartbeat.
        // Instantiated explicitly in Program.cs before the initial connect.
        services.AddSingleton(sp => new MqttEventHandler((HiveMQClient)sp.GetRequiredService<IHiveMQClient>()));

        //Configure Services: one PDU per configured instance, built by the factory + held in the registry.
        services.AddSingleton<PduInstanceFactory>();
        services.AddSingleton<PduInstanceRegistry>();
        // The "primary" instance backs GUI control/live/discovery; the registry holds every instance.
        services.AddSingleton<PDU>(sp => sp.GetRequiredService<PduInstanceRegistry>().Primary);

        services.AddSingleton<MQTTServiceDependencies>();

        // v2 producer/consumer pipeline (see docs/v2-architecture.md): the bus, a PDU poller (producer)
        // and the snapshot cache (first consumer). Existing services still read the PDU directly for now.
        services.AddSingleton<Core.IMessageBus, Core.ChannelMessageBus>();
        services.AddSingleton<Core.SnapshotCache>();
        services.AddSingleton<Core.ISnapshotCache>(sp => sp.GetRequiredService<Core.SnapshotCache>());
        // Owns the PDU producer(s) — one poller per configured instance; reconciled at runtime when the
        // GUI saves instance changes. Singleton + hosted-service facade so the GUI can trigger reconcile.
        services.AddSingleton<InstanceManager>();
        // The snapshot cache must drain the bus on any node that serves data. On a worker it consumes the
        // local poller; on a split API/UI node it consumes the worker's snapshots that the MqttBusBridge
        // ingests onto the bus. Without starting it here, a non-worker node's cache never fills and the
        // Status board shows "PDUs: no data yet / waiting on a worker node" forever even though the worker
        // is healthy (the consumer only publishes to the bus; nothing drained it).
        if (worker || api || ui)
        {
            services.AddHostedService(sp => sp.GetRequiredService<Core.SnapshotCache>());
        }
        // Shared liveness/readiness signals (uptime + last successful poll).
        services.AddSingleton<HealthState>();
        // What a save could not apply to this process — read by the status payload and the header badge.
        services.AddSingleton<Core.RestartPending>();
        // EmonCMS export health (last attempt/success/error) — read by the GUI even when disabled.
        // Optional features that were switched on but can't run. Registered before anything checks, so a
        // fault recorded during setup is visible to the Status board rather than only in the log.
        var faults = new Core.Startup.ConfigurationFaults();
        services.AddSingleton(faults);

        services.AddSingleton<Services.EmonCmsStatus>();

        AddCache(services, cfg);

        // Coordinates on-demand rediscovery (the "Rediscover" diagnostic button).
        services.AddSingleton<DiscoveryCoordinator>();

        // HA Energy-Dashboard sync (#128) — shared by the periodic worker service and the GUI's manual
        // sync/clear buttons, so register the engine singleton regardless of role.
        services.AddSingleton<Services.HaEnergyDashboardSync>();

        // EmonCMS feed provisioning (#163) — shared by the periodic provisioner and the GUI's "Provision
        // now" button, so register the singleton regardless of role.
        services.AddSingleton<Services.EmonCmsFeedSync>();

        // Live values from every in-process source, read through the IFlowValueSource seam. Sources write
        // straight into it, so a reading is visible the moment it arrives.
        var liveValues = new Core.Flow.FlowValueCache();

        // In-process sources emit measurement snapshots into this sink, which writes them into that cache.
        services.AddSingleton<Abstractions.Pipeline.ISnapshotSink<Abstractions.Flow.MeasurementSnapshot>>(sp =>
            new Core.Flow.FlowValueSink(liveValues, sp.GetService<Microsoft.Extensions.Logging.ILogger<Core.Flow.FlowValueSink>>()));
        // A write goes to the PDU that reported the device, once across replicas (the lease).
        services.AddSingleton<Abstractions.Pdu.IOutletControl, Services.DeviceOutletControl>();
        services.AddSingleton<Services.EnergyFlowMqttSourceService>();
        if (worker)
            services.AddHostedService(sp => sp.GetRequiredService<Services.EnergyFlowMqttSourceService>());

        // Modbus TCP is a second live-value ingest (#129): poll inverters/meters/PLCs into the same seam.
        // Self-gating too — with no connections/bindings configured it opens no sockets. Unlike the MQTT
        // source (broker fan-out is free), a Modbus device is a shared serial resource: many RS485-to-Ethernet
        // gateways accept only ONE TCP client at a time, so every process polling it independently causes
        // contention — the reads time out. So the poller runs only in the Worker role (data production);
        // the API/UI read the values through the same bus/exports as any other producer.
        services.AddSingleton<Services.EnergyFlowModbusSourceService>();
        // One poll per physical device (host:port:unitId), whatever the config says — two connections to
        // the same gateway are one reader, which is what keeps its single TCP slot free.
        services.AddSingleton<Core.Modbus.ModbusDevices>();
        if (worker)
            services.AddHostedService<Services.ModbusPollService>();



        // Reads prefer the in-process MQTT source cache: the GUI/exporters get the exact value the broker
        // callback just wrote, and crucially it carries the direction-qualified (e.g. realpower#in — battery
        // charge / grid export), state-of-charge (soc) and energy-in keys that the flow sink drops because
        // they are not canonical Metric names (Metrics.TryParse fails). Without this the battery SoC and
        // every in-direction reading show "—" even though the ingest has them.
        // Energy derived from power, for nodes that report watts but no cumulative kWh. It reads the
        // MEASURED sources only — passing it the composite it belongs to would be a cycle, and it must
        // integrate real readings rather than its own output.
        // Period (daily) totals are a separate concern from integration and default ON: they are the rise of
        // counters that already exist, not an estimate standing in for a missing meter. They are also what
        // makes the energy diagram add up at all, so the service is hosted for either reason.
        var aggregationOn = cfg.EnergyFlow.Aggregation.Enabled;
        var periodsOn = cfg.EnergyFlow.Aggregation.TrackPeriods;
        if (aggregationOn || periodsOn)
        {
            services.AddSingleton(sp => new Services.EnergyAggregationService(
                cfg,
                new Core.Flow.CompositeFlowValueSource(
                    sp.GetRequiredService<Services.EnergyFlowMqttSourceService>(), liveValues),
                sp.GetRequiredService<Core.Flow.IEnergyStore>(),
                sp.GetRequiredService<Core.ISnapshotCache>()));
            // Accumulating is data production, so only the worker does it — otherwise every replica would
            // integrate the same readings into its own copy of the counter.
            if (worker)
                services.AddHostedService(sp => sp.GetRequiredService<Services.EnergyAggregationService>());
            // Every other role still needs the numbers, and reading is not producing. Without this a split
            // deployment's GUI/exporters held a service that was never started, so every energy and daily
            // total read as no-data while the worker had them all.
            else if (api || ui)
                services.AddHostedService(sp => new Services.EnergyStoreReaderService(
                    cfg, sp.GetRequiredService<Services.EnergyAggregationService>()));
        }

        // Externally loaded plugins: reference Core, implement IIntegration, drop the DLL in plugins/.
        // A plugin that will not load is reported and skipped — a third-party DLL cannot stop the bridge.
        var plugins = Plugins.PluginLoader.Load(log: m => Log.Information(m));
        var pluginIntegrations = plugins.SelectMany(p => p.Integrations).ToList();
        if (pluginIntegrations.Count > 0)
        {
            Plugins.PluginLoader.Configure(pluginIntegrations, cfg, m => Log.Warning(m));
            foreach (var integration in pluginIntegrations)
                services.AddSingleton(typeof(Core.Integrations.IIntegration), integration);
        }
        // The GUI renders a settings page per plugin from this, with no plugin-supplied UI involved.
        PluginSections = Plugins.PluginLoader.Sections(pluginIntegrations).ToList();
        // Source types a plugin contributes, so the node editor offers them beside mqtt and modbus.
        Services.Gui.ConfigSchema.PluginSourceTypes = pluginIntegrations
            .OfType<Core.Integrations.IValueSourcePlugin>()
            .Select(p => (p.SourceType, p.SourceTypeLabel))
            .ToList();

        // Plugin-supplied sources join the same composite as the built-in ingests, so the flow graph cannot
        // tell where a value came from — which it never could, and is the whole point of the seam.
        // Built-in sources that speak the plugin contract are constructed ONCE, here, and registered as
        // that same instance. Two registrations gave the health-check registry a duplicate name; resolving
        // them from inside the IFlowValueSource factory instead was worse — several integrations take an
        // IFlowValueSource, so building it built them, which needed it, and startup simply hung.
        var haSource = new Integrations.HomeAssistant.HomeAssistantValueSource(cfg);
        services.AddSingleton<Core.Integrations.IIntegration>(haSource);
        // EmonCMS read as a source. Separate from the EmonCMS destination integration on purpose: they are
        // switched on by different things — the destination by EmonCMS.Enabled, this by something actually
        // being bound to a feed — and one card saying "Exporting" would say nothing about whether the reads
        // are working.
        services.AddSingleton(sp => new Integrations.EmonCms.EmonCmsValueSource(
            cfg, auditor: sp.GetService<Core.Flow.IPeriodAuditor>()));
        services.AddSingleton<Core.Integrations.IIntegration>(sp => sp.GetRequiredService<Integrations.EmonCms.EmonCmsValueSource>());
        // The two built-in ingests are integrations too — the SAME instances the flow already reads, so the
        // registry, the banner and the health board describe the thing that is actually running.
        services.AddSingleton<Core.Integrations.IIntegration>(sp => sp.GetRequiredService<Services.EnergyFlowMqttSourceService>());
        services.AddSingleton<Core.Integrations.IIntegration>(sp => sp.GetRequiredService<Services.EnergyFlowModbusSourceService>());

        var pluginSources = pluginIntegrations.OfType<Core.Integrations.IValueSourcePlugin>()
            .Cast<Core.Flow.IFlowValueSource>()
            .ToArray();

        // Values worked out from other values (current = power ÷ voltage) wrap the whole composite: the two
        // readings they divide may arrive from different ingests, and a measured reading still wins.
        services.AddSingleton<Core.Flow.IFlowValueSource>(sp => new Core.Flow.DerivedFlowValueSource(
            aggregationOn || periodsOn
            ? new Core.Flow.CompositeFlowValueSource(
                [sp.GetRequiredService<Services.EnergyFlowMqttSourceService>(),
                liveValues,
                haSource,
                sp.GetRequiredService<Integrations.EmonCms.EmonCmsValueSource>(),
                // LAST on purpose: the composite takes the first source with a fresh reading, so a node
                // with a real energy binding uses that and the derived total only fills a gap.
                .. pluginSources,
                // LAST on purpose: the composite takes the first source with a fresh reading, so a node
                // with a real energy binding uses that and the derived total only fills a gap. The history
                // fallback is behind even that — a stored value is older than anything else here.
                sp.GetRequiredService<Services.EnergyAggregationService>(),
                .. (cfg.History.Enabled && cfg.History.ValueFallback
                    ? new Core.Flow.IFlowValueSource[] { sp.GetRequiredService<Core.Flow.HistoryValueSource>() }
                    : [])])
            : new Core.Flow.CompositeFlowValueSource(
                [sp.GetRequiredService<Services.EnergyFlowMqttSourceService>(), liveValues,
                 haSource, sp.GetRequiredService<Integrations.EmonCms.EmonCmsValueSource>(), .. pluginSources,
                 .. (cfg.History.Enabled && cfg.History.ValueFallback
                     ? new Core.Flow.IFlowValueSource[] { sp.GetRequiredService<Core.Flow.HistoryValueSource>() }
                     : [])]), cfg));

        if (worker)
            services.AddHostedService<Services.ValueSourcePluginHost>();

        if (cfg.History.Enabled && cfg.History.ValueFallback)
            services.AddSingleton(sp => new Core.Flow.HistoryValueSource(
                sp.GetRequiredService<Core.Flow.IMeasurementHistory>(), cfg,
                () => cfg.EnergyFlow.Nodes.Select(n => n.Id).Where(id => !string.IsNullOrEmpty(id)).ToList()));

        // The history backend read as a source (opt-in). Registered here so it can be placed LAST in the
        // composite below — a stored value must never win over a live one, or a reading is replaced by its
        // own echo one refresh later.
        if (cfg.History.Enabled && cfg.History.ValueFallback)
            services.AddHostedService<Services.HistoryValueSourceService>();

        // A plugin that polls hardware is a reader like the Vertiv one, so the same poller drives it rather
        // than a parallel host — one cadence, one ownership lease, one write path.
        var devicePlugins = pluginIntegrations.OfType<Core.Integrations.IDeviceSourcePlugin>().ToList();
        if (devicePlugins.Count > 0)
            services.AddSingleton<Core.Integrations.IDeviceReader>(new Core.Integrations.PluginDeviceReader(devicePlugins));

        // ---- v4: integrations as plugins -------------------------------------------------------------
        // Discovered by reflection over the Engine assembly, never listed by hand: a registration list is
        // exactly what this replaces — the same integration used to be named in five places, any one of
        // which could be forgotten with no failure to show for it.
        foreach (var type in typeof(Services.DestinationHost).Assembly.GetTypes()
                     .Where(t => t is { IsClass: true, IsAbstract: false })
                     .Where(t => typeof(Core.Integrations.IIntegration).IsAssignableFrom(t))
                     // A built-in that is also a value source is wired explicitly below, as one instance
                     // the flow composite can also hold. Letting the scan add it too made two.
                     .Where(t => !typeof(Core.Flow.IFlowValueSource).IsAssignableFrom(t)))
            services.AddSingleton(typeof(Core.Integrations.IIntegration), type);

        services.AddSingleton(new Services.Gui.PluginSchemaSections(PluginSections));

        services.AddSingleton<Core.Integrations.IntegrationRegistry>();
        // An integration that is switched on and cannot run is recorded into the SAME faults collection the
        // Status board and GUI already read — registering a second one would have replaced the instance
        // already holding the logging-sink faults. The rule itself lives on the integration, so a plugin
        // participates without anything here knowing what it needs.
        services.AddHostedService<Hosting.IntegrationFaultReporter>();
        // Publishing to the broker without inheriting a hosting model: EmonCMS's MQTT transport and Home
        // Assistant discovery both need it, and neither IS the MQTT integration.
        services.AddSingleton<Core.Integrations.IMessagePublisher, Services.MqttMessagePublisher>();
        // …and the connection state behind a seam too, so no integration can tell which MQTT client this
        // build uses.
        services.AddSingleton<Core.Integrations.IBrokerConnection, Services.HiveMqBrokerConnection>();
        // Who can read a device instance. The poller asks these rather than calling the Vertiv client, so a
        // plugin device gets the same cadence, lease and write path the built-in one has.
        services.AddSingleton<Core.Integrations.IDeviceReader, Integrations.Vertiv.VertivDeviceReader>();

        // The broker's topics, offered as nodes to adopt through the same capability a plugin would use.
        services.AddSingleton<Core.Integrations.INodeProvider, Hosting.MqttNodeProvider>();
        services.AddSingleton<Core.Integrations.INodeProvider, Hosting.ModbusNodeProvider>();

        // One poller for every device — a configured PDU or one a plugin supplies — publishing snapshots
        // onto the bus that everything downstream already listens to.
        if (worker)
            services.AddHostedService<Services.DevicePollService>();

        // The PDU object-model publisher, off the hosting base class and onto the seam.
        services.AddSingleton<Services.MqttPduPublisher>();
        services.AddSingleton<Core.Integrations.IntegrationStatus>();
        // The Status board, in this process. Evaluated when read, so an age is never stale.
        services.AddSingleton<Core.Status.StatusBoard>();
        // The browsable topic index and the process list: in this process, leased and pruned on read.
        services.AddSingleton<Core.Discovery.TopicIndex>();
        services.AddSingleton<Core.Diagnostics.ProcessRegistry>();
        // Ownership of a shared resource. One process owns everything it can see; the seam stays so a
        // clustered implementation can be dropped in without an integration noticing.
        services.AddSingleton<Core.Integrations.ISingleOwnerLease, Core.Integrations.SoleOwnerLease>();

        // Who this process is — one identity for everything that reports on its behalf.
        services.AddSingleton<Hosting.ProcessIdentity>();

        // How this process restarts itself (#192). Under Kubernetes, ask the orchestrator to replace the pod:
        // stopping the process instead exits 0, which shows as a "Completed" pod and comes back on the
        // kubelet's backoff (minutes). Everywhere else, stopping is all there is — with a non-zero exit code
        // so "restart me" isn't indistinguishable from "my work here is done".
        services.AddSingleton<Hosting.StopProcessRestarter>();
        if (configSource is KubernetesConfigSource)
            services.AddSingleton<Core.IProcessRestarter>(sp => new Hosting.KubernetesPodRestarter(
                (KubernetesConfigSource)sp.GetRequiredService<IConfigSource>(),
                sp.GetRequiredService<Hosting.StopProcessRestarter>()));
        else
            services.AddSingleton<Core.IProcessRestarter>(sp => sp.GetRequiredService<Hosting.StopProcessRestarter>());

        // Each process registers itself so the GUI can list every role process in a split deployment.
        if (roles != HostRole.All)
            services.AddHostedService<Hosting.ProcessRegistrar>();

        // The Status board: this process reports the facts it can see (broker connection, last poll, export
        // outcome, itself) and the board decides what they mean.
        services.AddHostedService<Hosting.StatusReporter>();

        // Topic autocomplete for the Nodes editor. Registered everywhere with a broker connection, but it
        // only subscribes while someone is actually browsing (the index hands out short leases), so there
        // is no standing background indexer.
        services.AddHostedService<Hosting.MqttTopicIndexService>();

        // Listens for GUI-issued restart requests over the bus (#210), so a tier can be restarted remotely.
        // Loaded in every role/process; a matching request stops the process and the orchestrator restarts it.
        services.AddHostedService<Services.RestartCommandService>();

        // ---- Worker role: the data-processing workload (publish, export, discovery, control). ----
        if (worker)
        {

            // v4: destinations are plugins. They are registered unconditionally and self-gate on their own
            // Enabled(cfg) every pass, so a toggle in the GUI takes effect without a restart — and the host
            // builds ONE ExportPass and offers it to all of them, so none can quietly omit the hierarchy.
            services.AddHostedService<DestinationHost>();
            // Configuration is not a reading: it changes when the operator changes something, so each
            // publisher runs on its own (much slower) cadence rather than once per poll.
            services.AddHostedService<ConfigurationPublisherHost>();

            // Registered unconditionally and self-gating on the live HomeAssistant.DiscoveryEnabled, the same
            // way EmonCmsReconciler above honours its own toggle. Registering only when the flag happened to
            // be true at startup meant turning discovery ON later could not start a service that was never
            // registered — and the config watcher deliberately does not restart for HASS changes, so nothing
            // re-evaluated it either. The toggle read On while the process reported discovery disabled.
            services.AddHostedService<HomeAssistantDiscoveryService>();
            services.AddHostedService<DiagnosticService>();
            if (!cfg.HASS.DiscoveryEnabled)
                Log.Warning("Home Assistant discovery is off. Turning it on in the GUI takes effect on the next pass; no restart needed.");

            // Sync the energy-flow hierarchy into HA's Energy Dashboard via its WebSocket API (#128).
            // Registered unconditionally; it honors the live HomeAssistant.EnergyDashboard.Enabled toggle.

            // Outlet control is opt-in; only subscribe to command topics when explicitly enabled.
            if (cfg.Primary.ActionsEnabled)
            {
                if (string.IsNullOrEmpty(cfg.Primary.Credentials?.Username) || string.IsNullOrEmpty(cfg.Primary.Credentials?.Password))
                    Log.Warning("PDU.ActionsEnabled is true, but PDU credentials are not set. Outlet on/off control will fail until Pdu.Credentials (or RPDU2MQTT_PDU_USERNAME / RPDU2MQTT_PDU_PASSWORD) are provided.");

                Log.Information("Outlet control is ENABLED (ActionsEnabled).");
                services.AddHostedService<OutletCommandService>();
            }
        }

        // Optional HTTP health endpoints for container probes — useful in any role.
        if (cfg.Health.Enabled)
            services.AddHostedService<HealthService>();

        // ---- Api role: the read-only REST API + OpenAPI/Scalar docs on its own port. ----
        if (api && cfg.Api.Enabled)
            services.AddHostedService<ApiService>();

        // ---- Ui role: the embedded configuration GUI. ----
        if (ui && cfg.Gui.Enabled)
            services.AddHostedService<Services.Gui.GuiService>();
    }

    /// <summary>
    /// The shared cache and the energy store that sits on it.
    ///
    /// <para>
    /// Split out of <see cref="Configure"/> so it can be built in a test. Configure reads the config off
    /// disk before it registers anything, so the only way to exercise this was to start the whole app —
    /// which is why a registration that could never resolve reached a cluster. See
    /// CacheRegistrationTests: with the cache enabled the graph is now built for real, and a constructor
    /// that asks for something absent fails the build instead of the deployment.
    /// </para>
    /// </summary>
    public static void AddCache(IServiceCollection services, Config cfg)
    {
        // Registered whether or not the cache is enabled, so the Status board can say "not configured"
        // rather than the card simply being absent — an absent card looks like a feature that doesn't
        // exist, which is exactly the confusion this is meant to remove.
        // History reads whatever the readings were already exported to; the bridge stores none itself (#372).
        // Registered unconditionally, and the router reads Enabled and Provider per call — turning history
        // on, or switching backend, takes effect on the next request rather than at the next restart.
        // A dashboard read must not hang the page when the backend is down or slow.
        services.AddSingleton<Core.Flow.IMeasurementHistory>(_ =>
            new Services.FlowHistoryRouter(new HttpClient { Timeout = TimeSpan.FromSeconds(10) }, cfg));

        // The audit's verdicts have one owner; the ingests see only the port.
        services.AddSingleton<Core.Flow.IPeriodAuditor>(sp =>
            new Core.Flow.PeriodAuditor(sp.GetRequiredService<Core.Flow.IPeriodAuditStore>()));

        services.AddSingleton<Core.Flow.CacheHealth>();
        if (cfg.Cache.Enabled)
        {
            // Constructed explicitly: RedisCacheClient takes a CacheConfig, and only the whole Config is
            // ever registered. Adding it by type left DI hunting for a CacheConfig that was never there,
            // so the process died on boot — and with the cache on by default, on the default path.
            services.AddSingleton(sp => new Services.RedisCacheClient(cfg.Cache, sp.GetRequiredService<Core.Flow.CacheHealth>()));
            services.AddSingleton<Services.ICacheClient>(sp => sp.GetRequiredService<Services.RedisCacheClient>());
            services.AddSingleton<Core.Flow.IEnergyStore>(sp => new Services.RedisEnergyStore(
                sp.GetRequiredService<Services.ICacheClient>(), cfg.Cache.KeyPrefix, m => Log.Warning(m)));
            services.AddSingleton<Core.Flow.IPeriodAuditStore>(sp => new Services.RedisPeriodAuditStore(
                sp.GetRequiredService<Services.ICacheClient>(), cfg.Cache.KeyPrefix, m => Log.Warning(m)));
        }
        else
        {
            // A local file: correct for one process, and it keeps the counter across a restart, which is
            // the property that actually matters. It just can't be shared between replicas.
            services.AddSingleton<Core.Flow.IEnergyStore>(_ => new Core.Flow.FileEnergyStore(
                Path.Combine(AppContext.BaseDirectory, "energy-totals.json"), m => Log.Warning(m)));
            services.AddSingleton<Core.Flow.IPeriodAuditStore>(_ => new Core.Flow.FilePeriodAuditStore(
                Path.Combine(AppContext.BaseDirectory, "period-audit.json"), m => Log.Warning(m)));
        }
    }
}
