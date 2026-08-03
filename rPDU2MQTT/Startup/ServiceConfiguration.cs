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

        // v3: cluster-leadership, the enabler for a homogeneous fleet — scale by running N identical All-role
        // instances instead of separate worker/api/ui deployments. The "run once cluster-wide" work
        // (publishers/exporters) self-gates on holding the lease, so N instances don't duplicate output and
        // leadership fails over automatically. Only worker-capable instances contest leadership (the leader
        // must be able to run the exporters) — so a split deployment's single worker is always the leader,
        // while a homogeneous All-role fleet elects one of the replicas.
        services.AddSingleton<LeaderState>();
        if (worker)
            services.AddHostedService<Hosting.LeaderRenewalService>();

        // Bind Configuration + the source it came from (the GUI uses it to save).
        services.AddSingleton(cfg);
        services.AddSingleton(configSource);
        if (configSource is KubernetesConfigSource k8sSource)
        {
            services.AddSingleton(k8sSource);
            services.AddHostedService<KubernetesStatusService>();
            services.AddHostedService<KubernetesConfigWatcher>();

            // ---- Operator (#210): now an OperatorGrain (single-activation, cluster-wide). ----
            // The registry client is a grain dependency; the activator drives the grain's periodic check.
            // GUI check/switch/redeploy are direct grain calls — no more MQTT command topics or CR polling.
            services.AddSingleton<Services.Operator.IContainerRegistry, Services.Operator.ContainerRegistryClient>();
            if (worker)
                services.AddHostedService<Hosting.OperatorActivator>();
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
            // v3: PDU snapshots reach every process from the single-activation PduGrain via this sync
            // (publishes onto the local bus → snapshot cache), replacing the MqttBusBridge mirroring.
            services.AddHostedService<Hosting.PduSyncService>();
        }
        // v3: PDU polling is a single-activation grain per instance; this activator drives it (worker),
        // replacing InstanceManager's per-process poller. InstanceManager stays a singleton for the GUI
        // (primary repoint / reconcile) but no longer runs the pollers.
        if (worker)
            services.AddHostedService<Hosting.PduGrainActivator>();

        // Shared liveness/readiness signals (uptime + last successful poll).
        services.AddSingleton<HealthState>();
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

        // Energy-flow values from the broker (#205, e.g. Solar Assistant). v3: the MQTT ingest runs on the
        // worker and its values are pushed to the flow grain by MqttToFlowBridge; every other process reads
        // them back through the grain sync (no per-process subscription duplication). The singleton stays
        // registered everywhere so the bridge can resolve it on the worker.
        // v3: in-process sources emit into the flow grain through this sink (event-driven). The MQTT
        // subscription manager pushes each received value straight to the FlowGrain — no polling bridge.
        services.AddSingleton<Abstractions.Pipeline.ISnapshotSink<Abstractions.Flow.MeasurementSnapshot>, Hosting.FlowGrainSink>();
        // v3: outlet writes route to the per-outlet grain (single cluster-wide owner) — the "grains for
        // writing to PDUs". The command subscriber depends only on IOutletControl, not Orleans.
        services.AddSingleton<Abstractions.Pdu.IOutletControl, Hosting.OutletGrainControl>();
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
        // v3: one ModbusGrain per physical device (host:port:unitId), one owner cluster-wide. The reconciler
        // reads config and pushes each device its bindings; the grains self-poll. Removes gateway contention.
        if (worker)
            services.AddHostedService<Hosting.ModbusReconciler>();

        // v3: provision the polymorphic node-grain tree from the energy-flow config — each node becomes the
        // right grain type (measured leaf / aggregate / residual) owning exactly its configured children.
        if (worker)
            services.AddHostedService<Hosting.FlowReconciler>();

        // v3: a local mirror of the flow grain's live values (Modbus via the DeviceGrain, and later every
        // grain-fed source), synced by FlowGrainSyncService and read through the same IFlowValueSource seam.
        var grainSyncedFlow = new Core.Flow.FlowValueCache();
        if (worker || api || ui)
            services.AddHostedService(sp => new Hosting.FlowGrainSyncService(sp.GetRequiredService<Orleans.IGrainFactory>(), grainSyncedFlow));

        // Reads prefer the in-process MQTT source cache, then fall back to the grain-synced mirror. In a
        // single-binary (All-role) deployment the MQTT ingest runs in THIS process, so the GUI/exporters read
        // the exact value the broker callback just wrote — no cross-process grain round-trip to delay it, and
        // crucially it carries the direction-qualified (e.g. realpower#in — battery charge / grid export),
        // state-of-charge (soc) and energy-in keys that the flow-grain sink strips out because they aren't
        // canonical Metric names (Metrics.TryParse fails, so they never reach the grain or its mirror). Without
        // this the battery SoC and every in-direction reading show "—" even though the ingest has them.
        // In a UI-only split process the MQTT cache is never fed (the ingest isn't hosted there), so its reads
        // return false and everything falls through to the mirror — this is strictly additive, never a
        // regression. It is the single-binary deployment that makes it whole.
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
                    sp.GetRequiredService<Services.EnergyFlowMqttSourceService>(), grainSyncedFlow),
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

        services.AddSingleton<Core.Flow.IFlowValueSource>(sp => aggregationOn || periodsOn
            ? new Core.Flow.CompositeFlowValueSource(
                sp.GetRequiredService<Services.EnergyFlowMqttSourceService>(),
                grainSyncedFlow,
                // LAST on purpose: the composite takes the first source with a fresh reading, so a node
                // with a real energy binding uses that and the derived total only fills a gap.
                sp.GetRequiredService<Services.EnergyAggregationService>())
            : new Core.Flow.CompositeFlowValueSource(
                sp.GetRequiredService<Services.EnergyFlowMqttSourceService>(),
                grainSyncedFlow));

        // v3: the MqttBusBridge is retired — cross-process PDU snapshot propagation is the PduGrain +
        // PduSyncService's job now (grains, not MQTT mirroring).

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

        // v3: each process registers itself with the cluster-wide ProcessRegistryGrain so the GUI can list
        // every role process in a split deployment — replaces the MQTT HeartbeatService beacons.
        if (roles != HostRole.All)
            services.AddHostedService<Hosting.ProcessRegistrar>();

        // v3: the Status board is grains too — each process reports the facts it can see (broker connection,
        // last poll, export outcome, itself) to the owning component grain, which decides what they mean.
        services.AddHostedService<Hosting.StatusReporter>();

        // Topic autocomplete for the Nodes editor. Registered everywhere with a broker connection, but it
        // only subscribes while someone is actually browsing (the index grain hands out short leases), so
        // there is no standing background indexer.
        services.AddHostedService<Hosting.MqttTopicIndexService>();

        // Listens for GUI-issued restart requests over the bus (#210), so a tier can be restarted remotely.
        // Loaded in every role/process; a matching request stops the process and the orchestrator restarts it.
        services.AddHostedService<Services.RestartCommandService>();

        // ---- Worker role: the data-processing workload (publish, export, discovery, control). ----
        if (worker)
        {
            services.AddHostedService<MQTTPublishingService>();

            // Energy-hierarchy MQTT export (#164) — a no-op until EnergyFlow.MqttExport is enabled, which
            // the GUI can toggle at runtime, so register unconditionally rather than gating on the flag.
            services.AddHostedService<EnergyFlowMqttExportService>();

            // Optional metric exporters.
            if (cfg.Prometheus.Exporter || cfg.Prometheus.Pushgateway.Enabled)
                services.AddHostedService<PrometheusExportService>();

            if (cfg.EmonCMS.Enabled)
            {
                // Url is only needed for the HTTP transport; the MQTT transport uses the existing broker.
                // A missing one used to throw here, so enabling EmonCMS in the GUI before filling in the
                // URL left the process unable to start — taking the PDU poll, MQTT, HA and the flow with
                // it. Skip just this exporter and say so; nothing a toggle can do may stop the bridge.
                var emonFault = Core.Startup.DestinationRequirements.EmonCms(
                    cfg.EmonCMS.Enabled,
                    cfg.EmonCMS.Transport == Models.Config.EmonCmsTransport.Http,
                    cfg.EmonCMS.Url);
                if (emonFault is not null)
                {
                    Log.Error(emonFault.Message);
                    faults.Record(emonFault);
                }
                else
                    services.AddHostedService<EmonCmsExportService>();
            }

            // Feed auto-provisioning (#163) honors the live EmonCMS.Feeds.AutoConfigure toggle, so register
            // it unconditionally (self-gates on Enabled/AutoConfigure/Url/ApiKey each pass) — enabling it in
            // the GUI takes effect without a restart. v3: the writes to EmonCMS are owned by a single-
            // activation grain, so this only pokes it; "once cluster-wide" is the grain, not a leader check.
            services.AddHostedService<Hosting.EmonCmsReconciler>();

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
            services.AddHostedService<HaEnergyDashboardService>();

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
        }
        else
        {
            // A local file: correct for one process, and it keeps the counter across a restart, which is
            // the property that actually matters. It just can't be shared between replicas.
            services.AddSingleton<Core.Flow.IEnergyStore>(_ => new Core.Flow.FileEnergyStore(
                Path.Combine(AppContext.BaseDirectory, "energy-totals.json"), m => Log.Warning(m)));
        }
    }
}
