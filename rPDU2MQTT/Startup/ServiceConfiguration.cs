using HiveMQtt.Client;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using rPDU2MQTT.Classes;
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

        // Bind Configuration + the source it came from (the GUI uses it to save).
        services.AddSingleton(cfg);
        services.AddSingleton(configSource);
        if (configSource is KubernetesConfigSource k8sSource)
        {
            services.AddSingleton(k8sSource);
            services.AddHostedService<KubernetesStatusService>();
            services.AddHostedService<KubernetesConfigWatcher>();
        }

        // Configure Logging.
        services.ConfigureLogging(cfg);

        // Bind IHiveMQClient
        services.AddSingleton<IHiveMQClient, HiveMQClient>((sp) =>
        {
            ThrowError.TestRequiredConfigurationSection(cfg.MQTT, "MQTT");
            ThrowError.TestRequiredConfigurationSection(cfg.MQTT.Connection, "MQTT.Connection");
            ThrowError.TestRequiredConfigurationSection(cfg.MQTT.Connection.Host, "MQTT.Connection.Host");
            ThrowError.TestRequiredConfigurationSection(cfg.MQTT.Connection.Host, "MQTT.Connection.Port");

            var mqttBuilder = new HiveMQClientOptionsBuilder()
                .WithBroker(cfg.MQTT.Connection.Host)
                .WithPort(cfg.MQTT.Connection.Port!.Value)
                .WithClientId((cfg.MQTT.ClientID ?? "rpdu2mqtt") + Guid.NewGuid().ToString())
                .WithAutomaticReconnect(true)
                .WithKeepAlive(cfg.MQTT.KeepAlive);

            // Optional Last-Will so HA marks entities unavailable immediately on disconnect.
            if (cfg.MQTT.LastWill)
                mqttBuilder.WithLastWillAndTestament(new LastWillAndTestament(
                    MQTTHelper.StatusTopic(cfg.MQTT.ParentTopic), payload: "offline", HiveMQtt.MQTT5.Types.QualityOfService.AtLeastOnceDelivery, true));

            if (cfg.MQTT.Credentials?.Username is not null)
                mqttBuilder.WithUserName(cfg.MQTT.Credentials.Username);

            if (cfg.MQTT.Credentials?.Password is not null)
                mqttBuilder.WithPassword(ToSecureString(cfg.MQTT.Credentials.Password));

            // Return new client, with options applied.
            return new HiveMQClient(mqttBuilder.Build());
        });

        // Wires the client's connect/disconnect events and the online-status heartbeat.
        // Instantiated explicitly in Program.cs before the initial connect.
        services.AddSingleton(sp => new MqttEventHandler((HiveMQClient)sp.GetRequiredService<IHiveMQClient>()));

        //Configure Services
        services.AddSingleton<PDU>();

        // Create HttpClient for PDU.
        var pduHttpClient = services.AddHttpClient<PduApiHandler>(client =>
        {
            ThrowError.TestRequiredConfigurationSection(cfg.PDU, "PDU");
            ThrowError.TestRequiredConfigurationSection(cfg.PDU.Connection, "PDU.Connection");
            ThrowError.TestRequiredConfigurationSection(cfg.PDU.Connection.Host, "PDU.Connection.Host");
            UriBuilder uriBuilder = new UriBuilder();

            uriBuilder.Host = cfg.PDU.Connection.Host;
            uriBuilder.Port = cfg.PDU.Connection.Port ?? 80;

            if (!string.IsNullOrEmpty(cfg.PDU.Connection.Scheme))
                uriBuilder.Scheme = cfg.PDU.Connection.Scheme;
            else
                uriBuilder.Scheme = uriBuilder.Port switch
                {
                    80 => "http",
                    443 => "https",
                    _ => uriBuilder.Scheme
                };

            client.BaseAddress = uriBuilder.Uri;
            client.Timeout = TimeSpan.FromSeconds(cfg.PDU.Connection.TimeoutSecs ?? 15);
        });

        if (cfg.PDU.Connection.ValidateCertificate == false)
        {
            pduHttpClient.ConfigurePrimaryHttpMessageHandler(() =>
            {
                // Return HttpClientHandler with certificate validation completely disabled.
                return new HttpClientHandler
                {
                    ClientCertificateOptions = ClientCertificateOption.Manual,
                    ServerCertificateCustomValidationCallback = (_, _, _, _) => true
                };
            });
        }


        services.AddSingleton<MQTTServiceDependencies>();

        // v2 producer/consumer pipeline bus (not yet wired to producers/consumers; see docs/v2-architecture.md).
        services.AddSingleton<Core.IMessageBus, Core.ChannelMessageBus>();

        // Shared liveness/readiness signals (uptime + last successful poll).
        services.AddSingleton<HealthState>();
        // EmonCMS export health (last attempt/success/error) — read by the GUI even when disabled.
        services.AddSingleton<Services.EmonCmsStatus>();

        // Created hosted services.
        services.AddHostedService<MQTTPublishingService>();

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

        // Coordinates on-demand rediscovery (the "Rediscover" diagnostic button).
        services.AddSingleton<DiscoveryCoordinator>();

        if (cfg.HASS.DiscoveryEnabled)
        {
            services.AddHostedService<HomeAssistantDiscoveryService>();
            services.AddHostedService<DiagnosticService>();
        }
        else
            Log.Warning($"Home Assistant Discovery Disabled.");

        // Optional HTTP health endpoints for container probes.
        if (cfg.Health.Enabled)
            services.AddHostedService<HealthService>();

        // Optional embedded configuration GUI.
        if (cfg.Gui.Enabled)
            services.AddHostedService<Services.Gui.GuiService>();

        // Outlet control is opt-in; only subscribe to command topics when explicitly enabled.
        if (cfg.PDU.ActionsEnabled)
        {
            if (string.IsNullOrEmpty(cfg.PDU.Credentials?.Username) || string.IsNullOrEmpty(cfg.PDU.Credentials?.Password))
                Log.Warning("PDU.ActionsEnabled is true, but PDU credentials are not set. Outlet on/off control will fail until Pdu.Credentials (or RPDU2MQTT_PDU_USERNAME / RPDU2MQTT_PDU_PASSWORD) are provided.");

            Log.Information("Outlet control is ENABLED (ActionsEnabled).");
            services.AddHostedService<OutletCommandService>();
        }
    }

    /// <summary>Wrap a plaintext secret as a read-only SecureString (for APIs that require one).</summary>
    private static System.Security.SecureString ToSecureString(string value)
    {
        var secure = new System.Security.SecureString();
        foreach (var c in value)
            secure.AppendChar(c);
        secure.MakeReadOnly();
        return secure;
    }
}
