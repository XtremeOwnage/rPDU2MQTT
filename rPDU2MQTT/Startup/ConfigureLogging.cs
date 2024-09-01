﻿using Microsoft.Extensions.DependencyInjection;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Helpers;

namespace rPDU2MQTT.Startup;

public static class ConfigureLoggingExtension
{
    public static IServiceCollection ConfigureLogging(this IServiceCollection services, Config cfg)
    {
        services.AddSerilog(o =>
        {
            // HttpClient logging is extremely verbose.... Only show warnings.
            o.MinimumLevel.Override("System.Net.Http.HttpClient", Serilog.Events.LogEventLevel.Warning);
            o.Enrich.FromLogContext();
            if (cfg.Logging.Console.Enabled)
                o.WriteTo.Console(cfg.Logging.Console.Severity, outputTemplate: cfg.Logging.Console.Format);
            if (cfg.Logging.File.Enabled)
            {
                if (string.IsNullOrEmpty(cfg.Logging.File.Path))
                {
                    Log.Fatal("Config.Logging.File.Enabled=true, but, Config.Logging.File.Path is not specified. Please either provide a path, or disable Logging to file.");
                    ThrowError.TestRequiredConfigurationSection(cfg.Logging.File.Path, "Config.Logging.File.Path");
                }

                o.WriteTo.File(path: cfg.Logging.File.Path, restrictedToMinimumLevel: cfg.Logging.Console.Severity, outputTemplate: cfg.Logging.Console.Format);

            }

        });



        return services;
    }
}