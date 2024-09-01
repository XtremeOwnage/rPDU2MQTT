using HiveMQtt.Client;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using rPDU2MQTT.Startup;
using System.Runtime.InteropServices;

var host = Host.CreateDefaultBuilder(args)
    .ConfigureAppConfiguration(ConfigLoader.Configure)
    .ConfigureServices(ServiceConfiguration.Configure)
    .ConfigureLogging(logging =>
    {
        logging.ClearProviders();
logging.AddConsole();
    })
    .Build();

//Ensure we can actually connect to MQTT.
var client = host.Services.GetRequiredService<IHiveMQClient>();
var logger = host.Services.GetRequiredService<ILogger<IHiveMQClient>>();

Log.Information($"Connecting to MQTT Broker at {client.Options.Host}:{client.Options.Port}");

await client.ConnectAsync();

logger.LogInformation("Successfully connected to broker!");

host.Run();