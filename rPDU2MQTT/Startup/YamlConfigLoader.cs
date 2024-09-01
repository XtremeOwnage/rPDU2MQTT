﻿using rPDU2MQTT.Classes;
using Serilog;
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
                return file;
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

        return cfg;
    }
}
