using HiveMQtt.Client;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using rPDU2MQTT.Startup;

Log.Logger = new LoggerConfiguration()
    .Enrich.FromLogContext()
    .WriteTo.Console()
    .MinimumLevel.Is(Serilog.Events.LogEventLevel.Verbose)
    .CreateLogger();

var host = Host.CreateDefaultBuilder(args)
    .ConfigureAppConfiguration(o => { o.AddEnvironmentVariables(); })
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

Log.Information("Successfully connected to broker!");

host.Run();