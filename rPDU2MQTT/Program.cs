using HiveMQtt.Client;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Startup;
using rPDU2MQTT.Startup.ConfigSources;

// Emit the generated RpduConfig CRD manifest and exit (used to regenerate the committed manifests).
if (args.Contains("--emit-crd"))
{
    Console.Write(CrdGenerator.ToYaml());
    return 0;
}

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

// Instantiate the event handler now so its connect/disconnect handlers are wired before we connect.
host.Services.GetRequiredService<MqttEventHandler>();

Log.Information($"Connecting to MQTT Broker at {client.Options.Host}:{client.Options.Port}");

// Retry the initial connect (broker may still be starting up); the client auto-reconnects afterward.
const int maxAttempts = 10;
var retryDelay = TimeSpan.FromSeconds(5);

for (int attempt = 1; ; attempt++)
{
    try
    {
        var result = await client.ConnectAsync();

        // A refused connection (e.g. bad credentials) is not transient, so fail fast.
        if (result.ReasonCode != HiveMQtt.MQTT5.ReasonCodes.ConnAckReasonCode.Success)
        {
            Log.Fatal($"MQTT broker refused the connection: {result.ReasonCode} ({result.ReasonString}). Check the configured credentials and permissions.");
            return 1;
        }

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