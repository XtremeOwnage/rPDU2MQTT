using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;

namespace rPDU2MQTT.Startup;

public static class JsonConfigLoader
{
    /// <summary>
    /// This loads configuration from appsettings.json, and appsettings.$ENV.json
    /// </summary>
    /// <param name="context"></param>
    /// <param name="config"></param>
    public static void Configure(HostBuilderContext context, IConfigurationBuilder config)
    {
        string baseConfig = "appsettings.json";
        string envSpecificConfig = $"appsettings.{context.HostingEnvironment.EnvironmentName}.json";

        Log.Information("Loading JSON Configuration");
        Log.Information($"{baseConfig} exists: {File.Exists(baseConfig)}");
        Log.Information($"{envSpecificConfig} exists: {File.Exists(envSpecificConfig)}");

        //Check for configuration files in the current directory.
        config
            .SetBasePath(Directory.GetCurrentDirectory())
            .AddJsonFile(envSpecificConfig, optional: true, reloadOnChange: true)
            .AddEnvironmentVariables();
    }
}
