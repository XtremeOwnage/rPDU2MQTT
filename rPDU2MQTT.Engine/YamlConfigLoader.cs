using rPDU2MQTT.Classes;
using System.Runtime.InteropServices;
using YamlDotNet.Core;
using YamlDotNet.Serialization;
namespace rPDU2MQTT.Startup;
/// <summary>
/// This class, validates a YAML configuration exists, and returns the path.
/// </summary>
internal class YamlConfigLoader
{
    /// <summary>Path of the config file resolved at startup; the GUI reads/writes this same file.</summary>
    public static string? ResolvedPath { get; private set; }

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
                ResolvedPath = file;
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

    private static IDeserializer BuildDeserializer() =>
        new DeserializerBuilder()
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
            .WithEnforceRequiredMembers()
            // Accept the legacy string form of EmonCMS.Feeds.Types (#163) so old configs still load.
            .WithTypeConverter(new Models.Config.EmonCmsFeedTypeConfigYamlConverter())
            .Build();

    public static Config GetConfig()
    {
        using var stream = File.OpenRead(Find());
        using var sr = new StreamReader(stream);
        return Deserialize(sr);
    }

    /// <summary>Deserialize a YAML string into a fully-initialized <see cref="Config"/> (shared by the
    /// file and Kubernetes config sources).</summary>
    public static Config DeserializeString(string yaml) => Deserialize(new StringReader(yaml));

    private static Config Deserialize(TextReader reader)
    {
        try
        {
            var cfg = BuildDeserializer().Deserialize<Config>(reader);
            return Initialize(cfg);
        }
        catch (YamlException ex)
        {
            Log.Fatal($"Error while parsing YAML Config. Error on Line {ex.Start.Line}");
            throw;
        }
    }

    /// <summary>
    /// Initialize defaults, apply the back-compat alias, and layer environment/secret overrides.
    /// Shared by the file and Kubernetes config sources.
    /// </summary>
    public static Config Initialize(Config config)
    {
        // This- method exists, because apparently when you have an empty dictionary defined
        // yamldotnet, produces a null dictionary in return.
        // Instead of writing a custom deserializer, or screwing around reading tickets for 30 minutes-
        // I wrote this code. It works. it does the job. It ensures there isn't a null value.
        // KISS.
        config ??= new Config();

        config.Overrides ??= new Models.Config.Overrides();
        config.Overrides.rPDU2MQTT ??= new Models.Config.Schemas.EntityOverride();
        config.Overrides.Devices ??= new Dictionary<string, Models.Config.Schemas.DeviceOverride?>();
        config.Overrides.Measurements ??= new Dictionary<string, Models.Config.Schemas.EntityOverride?>();
        foreach (var (_, dvc) in config.Overrides.Devices)
            if (dvc is not null)
                dvc.Outlets ??= new Dictionary<int, Models.Config.Schemas.EntityOverride?>();

        config.Pdus ??= new Dictionary<string, Models.Config.PduConfig>();

        // v1 -> v2 auto-migration: a single `PDU:` section becomes the `default` instance in `Pdus`.
        if (config.PDU is not null)
        {
            if (config.Pdus.Count == 0)
            {
                Log.Warning($"Config uses the deprecated single 'PDU:' section; migrating it to 'Pdus: {{ {Config.DefaultInstanceKey}: ... }}'. Update your config to silence this warning.");
                config.Pdus[Config.DefaultInstanceKey] = config.PDU;
            }
            else
            {
                Log.Warning("Config has both the deprecated 'PDU:' section and 'Pdus:'; ignoring 'PDU:' (use 'Pdus:').");
            }
            config.PDU = null;
        }

        // Ensure at least one instance exists so a fresh/empty config doesn't NPE; a missing
        // Connection.Host then surfaces via the per-instance validation when the PDU is built.
        if (config.Pdus.Count == 0)
            config.Pdus[Config.DefaultInstanceKey] = new();

        // Backwards-compatible alias: Enable_Actions -> ActionsEnabled (per instance).
        foreach (var instance in config.Pdus.Values)
            if (instance.EnableActionsAlias.HasValue)
                instance.ActionsEnabled = instance.EnableActionsAlias.Value;

        // Backwards-compatible alias: the old Prometheus.Enabled meant "run the exporter".
        if (config.Prometheus.EnabledAlias == true)
            config.Prometheus.Exporter = true;

        ApplyEnvironmentOverrides(config);

        return config;
    }

    /// <summary>
    /// Override credentials from the environment so secrets don't have to live in config.yaml.
    /// For each variable, a "<NAME>_FILE" pointing at a file (Docker secret) takes precedence.
    /// </summary>
    private static void ApplyEnvironmentOverrides(Config config)
    {
        var mqttUser = ResolveSecret("RPDU2MQTT_MQTT_USERNAME");
        var mqttPass = ResolveSecret("RPDU2MQTT_MQTT_PASSWORD");
        if (mqttUser is not null || mqttPass is not null)
        {
            config.MQTT.Credentials ??= new Models.Config.Schemas.Credentials();
            if (mqttUser is not null) { config.MQTT.Credentials.Username = mqttUser; Log.Information("Using MQTT username from environment."); }
            if (mqttPass is not null) { config.MQTT.Credentials.Password = mqttPass; Log.Information("Using MQTT password from environment."); }
        }

        var pduUser = ResolveSecret("RPDU2MQTT_PDU_USERNAME");
        var pduPass = ResolveSecret("RPDU2MQTT_PDU_PASSWORD");
        if (pduUser is not null || pduPass is not null)
        {
            config.Primary.Credentials ??= new Models.Config.Schemas.Credentials();
            if (pduUser is not null) { config.Primary.Credentials.Username = pduUser; Log.Information("Using PDU username from environment."); }
            if (pduPass is not null) { config.Primary.Credentials.Password = pduPass; Log.Information("Using PDU password from environment."); }
        }

        var emonKey = ResolveSecret("RPDU2MQTT_EMONCMS_APIKEY");
        if (emonKey is not null) { config.EmonCMS.ApiKey = emonKey; Log.Information("Using EmonCMS API key from environment."); }

        var guiPass = ResolveSecret("RPDU2MQTT_GUI_PASSWORD");
        if (guiPass is not null) { config.Gui.Password = guiPass; Log.Information("Using GUI password from environment."); }

        var oidcSecret = ResolveSecret("RPDU2MQTT_OIDC_CLIENT_SECRET");
        if (oidcSecret is not null) { config.Gui.Oidc.ClientSecret = oidcSecret; Log.Information("Using OIDC client secret from environment."); }
    }

    /// <summary>
    /// Resolve a secret from "<name>_FILE" (a file path, e.g. a Docker secret) if present,
    /// otherwise from the environment variable itself. Returns null when neither is set.
    /// </summary>
    private static string? ResolveSecret(string name)
    {
        var filePath = Environment.GetEnvironmentVariable($"{name}_FILE");
        if (!string.IsNullOrWhiteSpace(filePath) && File.Exists(filePath))
            return File.ReadAllText(filePath).Trim();

        return Environment.GetEnvironmentVariable(name);
    }
}
