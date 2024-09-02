using rPDU2MQTT.Classes;
using System.Runtime.InteropServices;
using YamlDotNet.Serialization;
namespace rPDU2MQTT.Startup;
/// <summary>
/// This class, validates a YAML configuration exists, and returns the path.
/// </summary>
internal class YamlConfigLoader
{
    public static string Find()
    {
        Log.Information("Attempting to locate configuration file.");

        // Before starting- we need to validate a configuration file exists.
        string[] SearchPaths = RuntimeInformation.IsOSPlatform(OSPlatform.Windows) switch
        {
            true => [Environment.CurrentDirectory],
            false => ["/config", Environment.CurrentDirectory],
        };

        string[] FileNames = ["config"];

        string[] YamlExtensions = [".yaml", ".yml"];

        var combinations = from path in SearchPaths
                           from file in FileNames
                           from extension in YamlExtensions
                           select Path.Combine(path, $"{file}{extension}");

        foreach (var file in combinations)
        {
            if (File.Exists(file))
            {
                Log.Information($"Found config file at {file}");
                return file;
            }
        }

        /// At this point, we cannot find a configuration.
        /// Print an error to the console, and lets add a sleep / delay
        /// before throwing the exception.        

        Log.Error("Unable to locate config.yaml. Paths searched:");
        foreach (var file in combinations)
            Log.Error($"\t{file}");
        Log.Information("Restarting in 15 seconds.");

        System.Threading.Thread.Sleep(TimeSpan.FromSeconds(15));

        throw new Exception("Unable to locate config.yaml");
    }

    public static Config GetConfig()
    {
        var ds = new DeserializerBuilder()
            // Ignore case when deserializing
            .WithCaseInsensitivePropertyMatching()
            // Ignore fields.
            .IgnoreFields()
            // Ignore any non-required properties missing
            .IgnoreUnmatchedProperties()
            // Enforce Nullability
            .WithEnforceNullability()
            // Check for duplicate keys
            .WithDuplicateKeyChecking()
            // Enforce required attributes
            .WithEnforceRequiredMembers();

        IDeserializer s = ds.Build();

        using var stream = File.OpenRead(Find());
        using var sr = new StreamReader(stream);

        var cfg = s.Deserialize<Config>(sr);

        return InitializeConfig(cfg);
    }

    /// <summary>
    /// Just initializes values to default values.
    /// </summary>
    /// <param name="config"></param>
    private static Config InitializeConfig(Config config)
    {
        // This- method exists, because apparently when you have an empty dictionary defined
        // yamldotnet, produces a null dictionary in return.
        // Instead of writing a custom deserializer, or screwing around reading tickets for 30 minutes-
        // I wrote this code. It works. it does the job. It ensures there isn't a null value.
        // KISS.
        config ??= new Config();

        config.Overrides ??= new Models.Config.Overrides();
        config.Overrides.PDU ??= new Models.Config.Schemas.EntityOverride();
        config.Overrides.Devices ??= new Dictionary<string, Models.Config.Schemas.EntityOverride?>();
        config.Overrides.Outlets ??= new Dictionary<int, Models.Config.Schemas.EntityOverride?>();
        config.Overrides.Measurements ??= new Dictionary<string, Models.Config.Schemas.EntityOverride?>();


        return config;
    }
}
