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
    private WebApplication? app;

    public GuiService(Config config, IHiveMQClient mqtt, PDU pdu)
    {
        this.config = config;
        this.mqtt = mqtt;
        this.pdu = pdu;
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
    }

    private static string Version =>
        Assembly.GetExecutingAssembly().GetName().Version?.ToString() ?? "unknown";

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
