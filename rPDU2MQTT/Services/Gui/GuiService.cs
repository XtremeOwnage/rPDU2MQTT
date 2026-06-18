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
using rPDU2MQTT.Helpers;
using rPDU2MQTT.Startup;
using rPDU2MQTT.Startup.ConfigSources;

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
    private readonly IConfigSource configSource;
    private WebApplication? app;

    public GuiService(Config config, IHiveMQClient mqtt, PDU pdu, DiscoveryCoordinator discovery, IConfigSource configSource)
    {
        this.config = config;
        this.mqtt = mqtt;
        this.pdu = pdu;
        this.discovery = discovery;
        this.configSource = configSource;
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

        // Reflect the current source (file on disk or the CR), which may have been edited.
        app.MapGet("/api/config", () =>
        {
            Config current;
            try { current = configSource.Load(); }
            catch { current = config; }
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

            if (!configSource.CanWrite)
                return Results.Json(new { ok = false, message = "Configuration is read-only (e.g. a ConfigMap or ':ro' mount); cannot save. Use a writable source to edit from the GUI." }, statusCode: 409);

            try
            {
                await configSource.SaveAsync(parsed, ctx.RequestAborted);
                Log.Information($"Configuration saved via GUI to {configSource.Describe}.");
                var message = configSource.IsGitOpsManaged
                    ? "Saved to the Kubernetes resource. Remember to update your GitOps source so it doesn't drift. Restart to apply."
                    : "Saved. Restart the service to apply changes.";
                return Results.Json(new { ok = true, message, gitops = configSource.IsGitOpsManaged });
            }
            catch (Exception ex)
            {
                return Results.Json(new { ok = false, message = $"Failed to save config: {ex.Message}" }, statusCode: 500);
            }
        });

        // Export the current (edited) config as an RpduConfig CR manifest, secrets redacted.
        app.MapPost("/api/config/manifest", async (HttpContext ctx) =>
        {
            using var reader = new StreamReader(ctx.Request.Body);
            var json = await reader.ReadToEndAsync();
            try
            {
                return Results.Text(BuildManifest(ConfigSchema.FromJson(json)), "text/plain");
            }
            catch (Exception ex)
            {
                return Results.BadRequest(new { ok = false, message = $"Invalid configuration: {ex.Message}" });
            }
        });

        app.MapGet("/api/status", () => Results.Json(new
        {
            version = Version,
            configSource = configSource.Describe,
            configWritable = configSource.CanWrite,
            gitops = configSource.IsGitOpsManaged,
            mqttConnected = mqtt.IsConnected(),
            mqttHost = $"{mqtt.Options.Host}:{mqtt.Options.Port}",
            actionsEnabled = config.PDU.ActionsEnabled,
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
                        // 1-based: matches the PDU UI and the outlet override keys (Outlets.<n>).
                        index = o.Key + 1,
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

        // Live readings pulled from the PDU(s), for the read-only "Live Data" view.
        app.MapGet("/api/livedata", async (HttpContext ctx) =>
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ctx.RequestAborted);
            cts.CancelAfter(TimeSpan.FromSeconds(20));
            try
            {
                var data = await pdu.GetRootData_Public(cts.Token);
                var readings = MetricsHelper.EnumerateReadings(data)
                    .OrderBy(r => r.Device).ThenBy(r => r.Source).ThenBy(r => r.Type)
                    .Select(r => new { device = r.Device, source = r.Source, type = r.Type, value = r.Value, units = r.Units })
                    .ToList();
                return Results.Json(new { ok = true, count = readings.Count, readings }, ConfigSchema.Json);
            }
            catch (Exception ex)
            {
                return Results.Json(new { ok = false, message = $"Could not read live PDU data: {ex.Message}" }, ConfigSchema.Json);
            }
        });

        // Outlets available for control, with their current state (drives the Control tab).
        app.MapGet("/api/control/outlets", async (HttpContext ctx) =>
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ctx.RequestAborted);
            cts.CancelAfter(TimeSpan.FromSeconds(20));
            try
            {
                var data = await pdu.GetRootData_Public(cts.Token);
                var outlets = data.Devices.SelectMany(d => d.Outlets.OrderBy(o => o.Key).Select(o => new
                {
                    deviceId = d.Key,
                    device = d.Entity_DisplayName,
                    index = o.Key,        // raw key the control API expects
                    number = o.Key + 1,   // 1-based, matching the PDU UI
                    name = o.Entity_DisplayName,
                    state = pdu.ResolveOutletState(d.Key, o.Key, o.State),
                    onDelay = o.OnDelay,
                    offDelay = o.OffDelay,
                    rebootDelay = o.RebootDelay,
                    poaAction = o.PoaAction,
                })).ToList();
                return Results.Json(new { ok = true, actionsEnabled = config.PDU.ActionsEnabled, outlets }, ConfigSchema.Json);
            }
            catch (Exception ex)
            {
                return Results.Json(new { ok = false, message = $"Could not read live PDU data: {ex.Message}" }, ConfigSchema.Json);
            }
        });

        // Issue an outlet control action (on/off/reboot). Gated by PDU.ActionsEnabled.
        app.MapPost("/api/control/outlet", async (HttpContext ctx) =>
        {
            if (!config.PDU.ActionsEnabled)
                return Results.Json(new { ok = false, message = "Write actions are disabled (PDU.ActionsEnabled is false)." }, statusCode: 409);

            ControlRequest? req;
            try { req = await ctx.Request.ReadFromJsonAsync<ControlRequest>(ctx.RequestAborted); }
            catch { req = null; }
            if (req is null || string.IsNullOrWhiteSpace(req.DeviceId))
                return Results.BadRequest(new { ok = false, message = "deviceId, index and action are required." });

            var action = (req.Action ?? string.Empty).Trim().ToLowerInvariant();
            if (action is not ("on" or "off" or "reboot" or "resetstats"))
                return Results.BadRequest(new { ok = false, message = "action must be on, off, reboot or resetstats." });

            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ctx.RequestAborted);
            cts.CancelAfter(TimeSpan.FromSeconds(20));
            try
            {
                if (action == "resetstats")
                    await pdu.ResetOutletStatsAsync(req.DeviceId, req.Index, cts.Token);
                else
                    await pdu.ControlOutletAsync(req.DeviceId, req.Index, action, cts.Token);
                return Results.Json(new { ok = true, message = $"Outlet {req.Index + 1} → {action}." }, ConfigSchema.Json);
            }
            catch (Exception ex)
            {
                return Results.Json(new { ok = false, message = $"Control failed: {ex.Message}" }, ConfigSchema.Json);
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

    /// <summary>Body of a POST /api/control/outlet request.</summary>
    private sealed record ControlRequest(string DeviceId, int Index, string Action);

    private static string Version =>
        Assembly.GetExecutingAssembly().GetName().Version?.ToString() ?? "unknown";

    /// <summary>Render a config as an RpduConfig CR manifest (secrets redacted) for GitOps re-import.</summary>
    private static string BuildManifest(Config config)
    {
        var spec = ConfigSchema.ToYaml(ConfigSchema.RedactSecrets(config));
        var indentedSpec = string.Join("\n", spec.TrimEnd().Split('\n').Select(l => "    " + l));
        return
            "# Secrets are redacted; provide them via a Secret and the RPDU2MQTT_* env vars.\n" +
            $"apiVersion: {RpduCrd.ApiVersion}\n" +
            $"kind: {RpduCrd.Kind}\n" +
            "metadata:\n" +
            "  name: rpdu2mqtt\n" +
            "spec:\n" +
            indentedSpec + "\n";
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
