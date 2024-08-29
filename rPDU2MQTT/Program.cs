using HiveMQtt.Client;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Services;

var host = Host.CreateDefaultBuilder(args)
    .ConfigureAppConfiguration((context, config) =>
    {
        config.SetBasePath(Directory.GetCurrentDirectory())
              .AddJsonFile("appsettings.Development.json", optional: true, reloadOnChange: true)
              .AddEnvironmentVariables();
    })
    .ConfigureServices((context, services) =>
    {
        //Bind Configuration
        services.Configure<MQTTConfig>(context.Configuration.GetSection("Mqtt"));
        services.Configure<PduConfig>(context.Configuration.GetSection("Pdu"));
        services.Configure<ActionsConfig>(context.Configuration.GetSection("Actions"));
        services.Configure<HomeAssistantConfig>(context.Configuration.GetSection("HomeAssistant"));
        services.Configure<Overrides>(context.Configuration.GetSection("Overrides"));
        services.Configure<OutletOverrides>(context.Configuration.GetSection("Outlets"));
        services.Configure<MeasurementOverrides>(context.Configuration.GetSection("Measurements"));

        //Bind MQTT
        var mqttConfig = context.Configuration.GetSection("Mqtt").Get<MQTTConfig>() ?? throw new NullReferenceException("Unable to load MQTT configuration.");
        var mqttOptions = new HiveMQClientOptionsBuilder()
            .WithBroker(mqttConfig.Host)
            .WithPort(mqttConfig.Port)
            .WithUserName(mqttConfig.Username)
            .WithPassword(mqttConfig.Password)
            .WithClientId("rpdu2mqtt")
            .Build();

        var client = new HiveMQClient(mqttOptions);
        services.AddSingleton<IHiveMQClient>(client);
        services.AddSingleton<Config>();
        services.AddSingleton<ServiceDependancies>();

        // Create HttpClient for rPDU
        var pduConfiguration = context.Configuration.GetSection("Pdu").Get<PduConfig>() ?? throw new NullReferenceException();
        services.AddHttpClient("pdu", client =>
        {
            client.BaseAddress = new Uri(pduConfiguration.Url);
        });

        //Configure Services
        services.AddSingleton<PDU>(sp =>
        {
            var cfg = sp.GetRequiredService<Config>();
            var fac = sp.GetService<IHttpClientFactory>();
            var logFac = sp.GetService<ILoggerFactory>();
            var hc = fac.CreateClient("pdu");
            var log = logFac.CreateLogger<PDU>();
            return new PDU(cfg, hc, log);
        });


        services.AddHostedService<MQTTPublishingService>();
        services.AddHostedService<HomeAssistantDiscoveryService>();

    })
    .ConfigureLogging(logging =>
    {
        logging.ClearProviders();
        logging.AddConsole();
    })
    .Build();


//Ensure we can actually connect to MQTT.
var client = host.Services.GetRequiredService<IHiveMQClient>();
await client.ConnectAsync();

host.Run();