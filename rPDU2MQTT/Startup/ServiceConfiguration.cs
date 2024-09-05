using HiveMQtt.Client;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Helpers;
using rPDU2MQTT.Services;

namespace rPDU2MQTT.Startup;

public static class ServiceConfiguration
{
    public static void Configure(HostBuilderContext context, IServiceCollection services)
    {
        // While- we can request services when building dependancies-
        // Need the configuration DURING service collection initilization- 
        // Because it determiens which hosted services we want to add.
        Config cfg = YamlConfigLoader.GetConfig() ?? throw new Exception("Unable to load configuration");

        // Bind Configuration
        services.AddSingleton(cfg);

        // Configure Logging.
        services.ConfigureLogging(cfg);

        // Bind IHiveMQClient
        services.AddSingleton<IHiveMQClient, HiveMQClient>((sp) =>
        {
            ThrowError.TestRequiredConfigurationSection(cfg.MQTT, "MQTT");
            ThrowError.TestRequiredConfigurationSection(cfg.MQTT.Connection, "MQTT.Connection");
            ThrowError.TestRequiredConfigurationSection(cfg.MQTT.Connection.Host, "MQTT.Connection.Host");
            ThrowError.TestRequiredConfigurationSection(cfg.MQTT.Connection.Host, "MQTT.Connection.Port");

            var lwt = new LastWillAndTestament(
                MQTTHelper.JoinPaths(cfg.MQTT.ParentTopic, "Status"), payload: "offline", HiveMQtt.MQTT5.Types.QualityOfService.AtLeastOnceDelivery, true);

            var mqttBuilder = new HiveMQClientOptionsBuilder()
                .WithBroker(cfg.MQTT.Connection.Host)
                .WithPort(cfg.MQTT.Connection.Port!.Value)
                .WithClientId(cfg.MQTT.ClientID ?? "rpdu2mqtt")
                .WithAutomaticReconnect(true)
                .WithLastWillAndTestament(lwt);

            if (cfg.MQTT.Credentials?.Username is not null)
                mqttBuilder.WithUserName(cfg.MQTT.Credentials.Username);

            if (cfg.MQTT.Credentials?.Password is not null)
                mqttBuilder.WithPassword(cfg.MQTT.Credentials.Password);

            // Return new client, with options applied.
            var x = new HiveMQClient(mqttBuilder.Build());

            // While we are here- lets go ahead and create / bind the event handler.
            services.AddSingleton<MqttEventHandler>(new MqttEventHandler(x));
            return x;

            
        });

        //Configure Services
        services.AddSingleton<PDU>();

        // Create HttpClient for PDU.
        var pduHttpClient = services.AddHttpClient<PDU>(client =>
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


        services.AddSingleton<MQTTServiceDependancies>();

        // Created hosted services.
        services.AddHostedService<MQTTPublishingService>();

        if (cfg.HASS.DiscoveryEnabled)
            services.AddHostedService<HomeAssistantDiscoveryService>();
        else
            Log.Warning($"Home Assistant Discovery Disabled.");
    }
}
