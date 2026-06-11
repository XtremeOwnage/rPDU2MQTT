using System.Net;
using System.Reflection;
using System.Text;
using HiveMQtt.Client;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Startup;
using YamlDotNet.Serialization;

namespace rPDU2MQTT.Services.Gui;

/// <summary>
/// Optional embedded web GUI for viewing, editing and testing the configuration.
/// Hosts a small Kestrel app (Basic-auth protected) only when Gui.Enabled is set.
/// </summary>
public sealed class GuiService : IHostedService, IAsyncDisposable
{
    private readonly Config config;
    private readonly IHiveMQClient mqtt;
    private readonly PDU pdu;
    private readonly DiscoveryCoordinator discovery;
    private WebApplication? app;

    public GuiService(Config config, IHiveMQClient mqtt, PDU pdu, DiscoveryCoordinator discovery)
    {
        this.config = config;
        this.mqtt = mqtt;
        this.pdu = pdu;
        this.discovery = discovery;
    }

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        var gui = config.Gui;
        if (!gui.Enabled)
            return;

        if (string.IsNullOrWhiteSpace(gui.Password))
        {
            Log.Error("Configuration GUI is enabled but Gui.Password is not set. The GUI will not start.");
            return;
        }

        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { Args = Array.Empty<string>() });
        builder.Logging.ClearProviders();
        builder.WebHost.UseUrls($"http://*:{gui.Port}");

        app = builder.Build();
        app.Use(AuthMiddleware);
        MapEndpoints(app);

        await app.StartAsync(cancellationToken);
        Log.Information($"Configuration GUI listening on http://*:{gui.Port} (user '{gui.Username}').");
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        if (app is not null)
            await app.StopAsync(cancellationToken);
    }

    public async ValueTask DisposeAsync()
    {
        if (app is not null)
            await app.DisposeAsync();
    }

    /// <summary>HTTP Basic auth against the configured username/password.</summary>
    private async Task AuthMiddleware(HttpContext ctx, Func<Task> next)
    {
        if (IsAuthorized(ctx.Request))
        {
            await next();
            return;
        }

        ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
        ctx.Response.Headers.WWWAuthenticate = "Basic realm=\"rPDU2MQTT\"";
    }

    private bool IsAuthorized(HttpRequest request)
    {
        var header = request.Headers.Authorization.ToString();
        if (!header.StartsWith("Basic ", StringComparison.OrdinalIgnoreCase))
            return false;

        string decoded;
        try
        {
            decoded = Encoding.UTF8.GetString(Convert.FromBase64String(header["Basic ".Length..].Trim()));
        }
        catch (FormatException)
        {
            return false;
        }

        var split = decoded.IndexOf(':');
        if (split < 0)
            return false;

        var user = decoded[..split];
        var pass = decoded[(split + 1)..];
        return FixedEquals(user, config.Gui.Username) && FixedEquals(pass, config.Gui.Password ?? "");
    }

    // Length-independent constant-time-ish comparison to avoid leaking the password via timing.
    private static bool FixedEquals(string a, string b)
    {
        var ba = Encoding.UTF8.GetBytes(a);
        var bb = Encoding.UTF8.GetBytes(b);
        return System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(
            System.Security.Cryptography.SHA256.HashData(ba),
            System.Security.Cryptography.SHA256.HashData(bb));
    }

    private void MapEndpoints(WebApplication app)
    {
        app.MapGet("/", () => Results.Content(LoadIndexHtml(), "text/html"));

        app.MapGet("/api/schema", () => Results.Json(ConfigSchema.Build(), ConfigSchema.Json));

        // Reflect the on-disk config (which may have been edited) rather than the running singleton.
        app.MapGet("/api/config", () =>
        {
            var current = LoadConfigFromFile() ?? config;
            return Results.Content(ConfigSchema.ToJson(current), "application/json");
        });

        app.MapPost("/api/config", async (HttpContext ctx) =>
        {
            using var reader = new StreamReader(ctx.Request.Body);
            var json = await reader.ReadToEndAsync();

            Config parsed;
            try
            {
                parsed = ConfigSchema.FromJson(json);
            }
            catch (Exception ex)
            {
                return Results.BadRequest(new { ok = false, message = $"Invalid configuration: {ex.Message}" });
            }

            var path = YamlConfigLoader.ResolvedPath;
            if (string.IsNullOrEmpty(path))
                return Results.Json(new { ok = false, message = "Config file path is unknown; cannot save." }, statusCode: 500);

            if (!IsConfigWritable())
                return Results.Json(new { ok = false, message = "Config file is read-only (e.g. a Kubernetes ConfigMap or a ':ro' mount); cannot save. Mount it from a writable volume to edit from the GUI." }, statusCode: 409);

            try
            {
                // Keep a single rolling backup before overwriting.
                if (File.Exists(path))
                    File.Copy(path, path + ".bak", overwrite: true);

                await File.WriteAllTextAsync(path, ConfigSchema.ToYaml(parsed));
                Log.Information($"Configuration saved via GUI to {path}. Restart to apply.");
                return Results.Json(new { ok = true, message = "Saved. Restart the service to apply changes.", path });
            }
            catch (Exception ex)
            {
                return Results.Json(new { ok = false, message = $"Failed to write config: {ex.Message}" }, statusCode: 500);
            }
        });

        app.MapGet("/api/status", () => Results.Json(new
        {
            version = Version,
            configPath = YamlConfigLoader.ResolvedPath,
            configWritable = IsConfigWritable(),
            mqttConnected = mqtt.IsConnected(),
            mqttHost = $"{mqtt.Options.Host}:{mqtt.Options.Port}",
        }, ConfigSchema.Json));

        app.MapPost("/api/test/mqtt", () =>
        {
            var connected = mqtt.IsConnected();
            return Results.Json(new
            {
                ok = connected,
                message = connected
                    ? $"Connected to {mqtt.Options.Host}:{mqtt.Options.Port}."
                    : $"Not connected to {mqtt.Options.Host}:{mqtt.Options.Port}.",
            }, ConfigSchema.Json);
        });

        app.MapPost("/api/test/pdu", async (HttpContext ctx) =>
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ctx.RequestAborted);
            cts.CancelAfter(TimeSpan.FromSeconds(20));
            try
            {
                var data = await pdu.GetRootData_Public(cts.Token);
                var devices = data.Devices?.Count ?? 0;
                var outlets = data.Devices?.Sum(d => d.Outlets?.Count ?? 0) ?? 0;
                return Results.Json(new
                {
                    ok = true,
                    message = $"Reached PDU: {devices} device(s), {outlets} outlet(s).",
                }, ConfigSchema.Json);
            }
            catch (Exception ex)
            {
                return Results.Json(new { ok = false, message = $"PDU request failed: {ex.Message}" }, ConfigSchema.Json);
            }
        });

        // Live discovered structure (keys + current names) so the Overrides editor can be driven by
        // the actual devices/outlets/measurements instead of blindly-typed dictionary keys.
        app.MapGet("/api/live", async (HttpContext ctx) =>
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ctx.RequestAborted);
            cts.CancelAfter(TimeSpan.FromSeconds(20));
            try
            {
                var data = await pdu.GetRootData_Public(cts.Token);

                // Expose the raw PDU label/name plus the currently-discovered display name and
                // object_id, so the Overrides editor can show what each entity actually is.
                var devices = data.Devices.Select(d => new
                {
                    key = d.Key,
                    label = d.Label,
                    name = d.Name,
                    displayName = d.Entity_DisplayName,
                    objectId = d.Entity_Name,
                    outlets = d.Outlets.OrderBy(o => o.Key).Select(o => new
                    {
                        index = o.Key,
                        label = o.Label,
                        name = o.Name,
                        displayName = o.Entity_DisplayName,
                        objectId = o.Entity_Name,
                    }).ToList(),
                }).ToList();

                var measurements = data.Devices
                    .SelectMany(d => d.Outlets.SelectMany(o => o.Measurements)
                        .Concat(d.Entity.SelectMany(e => e.Measurements)))
                    .Where(m => !string.IsNullOrEmpty(m.Type))
                    .GroupBy(m => m.Type, StringComparer.OrdinalIgnoreCase)
                    .OrderBy(g => g.Key)
                    .Select(g => new { type = g.Key, units = g.Select(m => m.Units).FirstOrDefault(u => !string.IsNullOrEmpty(u)) })
                    .ToList();

                var groups = data.Groups.Select(g => new
                {
                    key = g.Key,
                    label = g.Label,
                    name = g.Name,
                    displayName = g.Entity_DisplayName,
                }).ToList();

                return Results.Json(new { ok = true, devices, measurements, groups }, ConfigSchema.Json);
            }
            catch (Exception ex)
            {
                return Results.Json(new { ok = false, message = $"Could not read live PDU data: {ex.Message}" }, ConfigSchema.Json);
            }
        });

        // Render the current form state as YAML (for copy/paste into a ConfigMap, source control, etc.).
        app.MapPost("/api/config/yaml", async (HttpContext ctx) =>
        {
            using var reader = new StreamReader(ctx.Request.Body);
            var json = await reader.ReadToEndAsync();
            try
            {
                return Results.Text(ConfigSchema.ToYaml(ConfigSchema.FromJson(json)), "text/plain");
            }
            catch (Exception ex)
            {
                return Results.BadRequest(new { ok = false, message = $"Invalid configuration: {ex.Message}" });
            }
        });

        app.MapPost("/api/discovery/rediscover", async () =>
        {
            if (!discovery.HasSubscribers)
                return Results.Json(new { ok = false, message = "Home Assistant discovery is disabled." }, ConfigSchema.Json);

            await discovery.RequestRediscoverAsync(CancellationToken.None);
            return Results.Json(new { ok = true, message = "Discovery republish requested." }, ConfigSchema.Json);
        });

        app.MapPost("/api/discovery/clear", async () =>
        {
            if (!discovery.HasSubscribers)
                return Results.Json(new { ok = false, message = "Home Assistant discovery is disabled." }, ConfigSchema.Json);

            await discovery.RequestClearAsync(CancellationToken.None);
            return Results.Json(new { ok = true, message = "Cleared the retained Home Assistant discovery messages." }, ConfigSchema.Json);
        });
    }

    private static string Version =>
        Assembly.GetExecutingAssembly().GetName().Version?.ToString() ?? "unknown";

    /// <summary>
    /// Whether the config file can be written. A ConfigMap-mounted (or ':ro') config is read-only,
    /// so the GUI is view/test-only there; this lets the UI disable Save instead of failing on submit.
    /// </summary>
    private static bool IsConfigWritable()
    {
        var path = YamlConfigLoader.ResolvedPath;
        if (string.IsNullOrEmpty(path))
            return false;

        try
        {
            if (File.Exists(path))
            {
                using var fs = new FileStream(path, FileMode.Open, FileAccess.Write, FileShare.ReadWrite);
                return true;
            }

            var dir = Path.GetDirectoryName(path);
            return !string.IsNullOrEmpty(dir) && Directory.Exists(dir);
        }
        catch
        {
            return false;
        }
    }

    /// <summary>Load the config straight from disk (no environment-secret overrides) for editing.</summary>
    private static Config? LoadConfigFromFile()
    {
        var path = YamlConfigLoader.ResolvedPath;
        if (string.IsNullOrEmpty(path) || !File.Exists(path))
            return null;

        try
        {
            var deserializer = new DeserializerBuilder()
                .WithCaseInsensitivePropertyMatching()
                .IgnoreFields()
                .IgnoreUnmatchedProperties()
                .Build();
            using var sr = new StreamReader(path);
            return deserializer.Deserialize<Config>(sr);
        }
        catch (Exception ex)
        {
            Log.Warning($"GUI could not read config file for editing: {ex.Message}");
            return null;
        }
    }

    private static string LoadIndexHtml()
    {
        var asm = Assembly.GetExecutingAssembly();
        var name = asm.GetManifestResourceNames().FirstOrDefault(n => n.EndsWith("index.html", StringComparison.OrdinalIgnoreCase));
        if (name is null)
            return "<html><body><h1>rPDU2MQTT</h1><p>GUI assets missing.</p></body></html>";

        using var stream = asm.GetManifestResourceStream(name)!;
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }
}
