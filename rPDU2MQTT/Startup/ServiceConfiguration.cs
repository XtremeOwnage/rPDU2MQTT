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
            services.AddHostedService(sp => sp.GetRequiredService<Core.SnapshotCache>());
        // Data production (the PDU pollers) runs only in the Worker role.
        if (worker)
            services.AddHostedService(sp => sp.GetRequiredService<InstanceManager>());

        // Shared liveness/readiness signals (uptime + last successful poll).
        services.AddSingleton<HealthState>();
        // EmonCMS export health (last attempt/success/error) — read by the GUI even when disabled.
        services.AddSingleton<Services.EmonCmsStatus>();

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
        services.AddSingleton<Services.EnergyFlowMqttSourceService>();
        if (worker)
        {
            services.AddHostedService(sp => sp.GetRequiredService<Services.EnergyFlowMqttSourceService>());
            services.AddHostedService<Hosting.MqttToFlowBridge>();
        }

        // Modbus TCP is a second live-value ingest (#129): poll inverters/meters/PLCs into the same seam.
        // Self-gating too — with no connections/bindings configured it opens no sockets. Unlike the MQTT
        // source (broker fan-out is free), a Modbus device is a shared serial resource: many RS485-to-Ethernet
        // gateways accept only ONE TCP client at a time, so every process polling it independently causes
        // contention — the reads time out. So the poller runs only in the Worker role (data production);
        // the API/UI read the values through the same bus/exports as any other producer.
        services.AddSingleton<Services.EnergyFlowModbusSourceService>();
        // v3: the Modbus device is polled by its single-activation DeviceGrain (one owner cluster-wide),
        // driven by this activator — not by a per-process poller. Removes single-client-gateway contention.
        if (worker)
            services.AddHostedService<Hosting.DeviceGrainActivator>();

        // v3: a local mirror of the flow grain's live values (Modbus via the DeviceGrain, and later every
        // grain-fed source), synced by FlowGrainSyncService and read through the same IFlowValueSource seam.
        var grainSyncedFlow = new Core.Flow.FlowValueCache();
        if (worker || api || ui)
            services.AddHostedService(sp => new Hosting.FlowGrainSyncService(sp.GetRequiredService<Orleans.IGrainFactory>(), grainSyncedFlow));

        // v3: every process reads flow values through the grain-synced mirror — Modbus (DeviceGrain) and MQTT
        // (MqttToFlowBridge) both feed the flow grain, so this one source has all of it. No per-process ingest.
        services.AddSingleton<Core.Flow.IFlowValueSource>(grainSyncedFlow);

        // When roles are split across processes, bridge the in-process snapshot bus over MQTT: a Worker
        // mirrors its snapshots to the broker; a consumer-only node ingests them onto its own bus/cache.
        // Single-node "all" keeps the bus fully in-process and skips this (no extra broker traffic).
        if (roles != HostRole.All)
            services.AddHostedService(sp => new Services.MqttBusBridge(
                sp.GetRequiredService<IHiveMQClient>(),
                sp.GetRequiredService<Core.IMessageBus>(),
                sp.GetRequiredService<Config>(),
                producer: worker));

        // Per-process liveness beacons so the GUI can list every role process in a split deployment.
        // Always resolvable (the GUI reads it); only runs the publish/subscribe loop when roles are split.
        services.AddSingleton<Services.HeartbeatService>();
        if (roles != HostRole.All)
            services.AddHostedService(sp => sp.GetRequiredService<Services.HeartbeatService>());

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
                if (cfg.EmonCMS.Transport == Models.Config.EmonCmsTransport.Http)
                    ThrowError.TestRequiredConfigurationSection(cfg.EmonCMS.Url, "EmonCMS.Url");
                services.AddHostedService<EmonCmsExportService>();
            }

            // Feed auto-provisioning (#163) honors the live EmonCMS.Feeds.AutoConfigure toggle, so register
            // it unconditionally (self-gates on Enabled/AutoConfigure/Url/ApiKey each pass) — enabling it in
            // the GUI takes effect without a restart.
            services.AddHostedService<EmonCmsFeedProvisioner>();

            if (cfg.HASS.DiscoveryEnabled)
            {
                services.AddHostedService<HomeAssistantDiscoveryService>();
                services.AddHostedService<DiagnosticService>();
            }
            else
                Log.Warning($"Home Assistant Discovery Disabled.");

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
}
