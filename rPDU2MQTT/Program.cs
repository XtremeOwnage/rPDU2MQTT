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

Log.Information($"Connecting to MQTT Broker at {client.Options.Host}:{client.Options.Port}");

// The broker may not be reachable yet (e.g. still starting up alongside us in a
// container). Retry the initial connection with a backoff before giving up, rather
// than crashing with an unhandled exception. Once connected, the client is configured
// to automatically reconnect, so we only need to handle the very first connect here.
const int maxAttempts = 10;
var retryDelay = TimeSpan.FromSeconds(5);

for (int attempt = 1; ; attempt++)
{
    try
    {
        await client.ConnectAsync();
        Log.Information("Successfully connected to broker!");
        break;
    }
    catch (Exception ex) when (attempt < maxAttempts)
    {
        Log.Warning($"Failed to connect to MQTT broker at {client.Options.Host}:{client.Options.Port} (attempt {attempt}/{maxAttempts}): {ex.Message}. Retrying in {retryDelay.TotalSeconds:0}s...");
        await Task.Delay(retryDelay);
    }
    catch (Exception ex)
    {
        Log.Fatal(ex, $"Unable to connect to MQTT broker at {client.Options.Host}:{client.Options.Port} after {maxAttempts} attempts. Exiting.");
        return 1;
    }
}

host.Run();

return 0;