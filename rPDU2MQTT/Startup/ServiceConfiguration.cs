using HiveMQtt.Client;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Services;

namespace rPDU2MQTT.Startup;

public static class ServiceConfiguration
{
    public static void Configure(HostBuilderContext context, IServiceCollection services)
    {
        // While- we can request services when building dependancies-
        // Need the configuration DURING service collection initilization- 
        // Because it determiens which hosted services we want to add.
        Config cfg = FindYamlConfig.GetConfig() ?? throw new Exception("Unable to load configuration");

        // Bind Configuration
        services.AddSingleton(cfg);

        bool mqttEnabled = !string.IsNullOrEmpty(cfg.MQTT?.Host);
        if (!mqttEnabled)
            Console.WriteLine("Error: No MQTT configuration found. MQTT-related services will not be started.");

        if (mqttEnabled)
            // Bind IHiveMQClient
            services.AddSingleton<IHiveMQClient, HiveMQClient>((sp) =>
            {
                if (cfg.MQTT is null)
                    throw new Exception("Configuration: MQTT is required.");

                var mqttBuilder = new HiveMQClientOptionsBuilder()
                    .WithBroker(cfg.MQTT?.Host ?? throw new Exception("Configuration: MQTT.Host is required."))
                    .WithPort(cfg.MQTT.Port)
                    .WithClientId(cfg.MQTT.ClientID ?? "rpdu2mqtt");

                if (cfg.MQTT.Credentials?.Username is not null)
                    mqttBuilder.WithUserName(cfg.MQTT.Credentials.Username);

                if (cfg.MQTT.Credentials?.Password is not null)
                    mqttBuilder.WithPassword(cfg.MQTT.Credentials.Password);

                // Return new client, with options applied.
                return new HiveMQClient(mqttBuilder.Build());
            });

        // Create HttpClient for PDU.
        services.AddHttpClient<PDU>(client =>
        {
            client.BaseAddress = new Uri(cfg.PDU.Url);
            client.Timeout = TimeSpan.FromSeconds(cfg.PDU.Timeout);
        });

        //Configure Services
        services.AddSingleton<PDU>();


        if (mqttEnabled)
        {
            services.AddSingleton<MQTTServiceDependancies>();

            // Created hosted services.
            services.AddHostedService<MQTTPublishingService>();

            if (cfg.HASS.DiscoveryEnabled)
                services.AddHostedService<HomeAssistantDiscoveryService>();
        }
        else
        {
            Console.WriteLine("MQTT Publishing and Discovery services disabled, due to MQTT Configuration missing.");
        }
    }
}
