using Microsoft.Extensions.DependencyInjection;
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
            o.MinimumLevel.Is(Serilog.Events.LogEventLevel.Verbose);
            o.Enrich.FromLogContext();
            if (cfg.Logging.Console.Enabled)
                o.WriteTo.Console(cfg.Logging.Console.Severity, outputTemplate: cfg.Logging.Console.Format);

            // Configure logging to file.
            if (cfg.Logging.File.Enabled)
            {
                if (string.IsNullOrEmpty(cfg.Logging.File.Path))
                {
                    Log.Fatal("Config.Logging.File.Enabled=true, but, Config.Logging.File.Path is not specified. Please either provide a path, or disable Logging to file.");
                    ThrowError.TestRequiredConfigurationSection(cfg.Logging.File.Path, "Config.Logging.File.Path");
                }

                o.WriteTo.File(path: cfg.Logging.File.Path
                    , restrictedToMinimumLevel: cfg.Logging.Console.Severity
                    , outputTemplate: cfg.Logging.Console.Format
                    , rollingInterval: cfg.Logging.File.FileRollover
                    , retainedFileCountLimit: cfg.Logging.File.FileRetention);

                Log.Debug("Will log to file at " + cfg.Logging.File.Path);
            }
            else
                Log.Debug("Will not log to file.");

            // Configure logging to a remote syslog server.
            if (cfg.Logging.Syslog.Enabled)
            {
                var sl = cfg.Logging.Syslog;
                ThrowError.TestRequiredConfigurationSection(sl.Host, "Config.Logging.Syslog.Host");

                if (sl.Protocol == Models.Config.Schemas.SyslogProtocol.TCP)
                    o.WriteTo.TcpSyslog(sl.Host, sl.Port, appName: sl.AppName, restrictedToMinimumLevel: sl.Severity);
                else
                    o.WriteTo.UdpSyslog(sl.Host, sl.Port, appName: sl.AppName, restrictedToMinimumLevel: sl.Severity);

                Log.Debug($"Will log to syslog at {sl.Host}:{sl.Port} ({sl.Protocol}).");
            }
        });

        return services;
    }
}
