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
            // A sink that cannot be built is dropped, not fatal: "log to file" is a toggle in the GUI, and
            // switching it on before naming a path must not stop the bridge from starting.
            var fileFault = Core.Startup.DestinationRequirements.FileLog(cfg.Logging.File.Enabled, cfg.Logging.File.Path);
            if (fileFault is not null)
                Console.Error.WriteLine("[config] " + fileFault.Message);   // the logger isn't built yet

            if (cfg.Logging.File.Enabled && fileFault is null && cfg.Logging.File.Path is { Length: > 0 } logPath)
            {
                // The file sink's own level and format — it used to be given the console's, which made the
                // one combination people actually want (quiet console, full detail on disk) impossible.
                o.WriteTo.File(path: logPath
                    , restrictedToMinimumLevel: cfg.Logging.File.Severity
                    , outputTemplate: cfg.Logging.File.Format
                    , rollingInterval: cfg.Logging.File.FileRollover
                    , retainedFileCountLimit: cfg.Logging.File.FileRetention);

                Log.Debug("Will log to file at " + cfg.Logging.File.Path);
            }
            else
                Log.Debug("Will not log to file.");

            // Configure logging to a remote syslog server.
            var syslogFault = Core.Startup.DestinationRequirements.Syslog(cfg.Logging.Syslog.Enabled, cfg.Logging.Syslog.Host);
            if (syslogFault is not null)
                Console.Error.WriteLine("[config] " + syslogFault.Message);

            if (cfg.Logging.Syslog.Enabled && syslogFault is null)
            {
                var sl = cfg.Logging.Syslog;

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
