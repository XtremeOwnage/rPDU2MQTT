using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;

namespace rPDU2MQTT.Startup;

public static class ConfigLoader
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

        Console.WriteLine("Loading JSON Configuration");
        Console.WriteLine($"{baseConfig} exists: {File.Exists(baseConfig)}");
        Console.WriteLine($"{envSpecificConfig} exists: {File.Exists(envSpecificConfig)}");

        //Check for configuration files in the current directory.
        config
            .SetBasePath(Directory.GetCurrentDirectory())
            .AddJsonFile(envSpecificConfig, optional: true, reloadOnChange: true)
            .AddEnvironmentVariables();
    }
}
