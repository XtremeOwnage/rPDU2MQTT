using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using HiveMQtt.Client;
using k8s;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authentication.OpenIdConnect;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Helpers;
using rPDU2MQTT.Models.Config;
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
    private readonly IHostApplicationLifetime lifetime;
    private readonly HealthState health;
    private readonly PduApiHandler pduApi;
    private WebApplication? app;

    public GuiService(Config config, IHiveMQClient mqtt, PDU pdu, DiscoveryCoordinator discovery, IConfigSource configSource, IHostApplicationLifetime lifetime, HealthState health, PduApiHandler pduApi)
    {
        this.config = config;
        this.mqtt = mqtt;
        this.pdu = pdu;
        this.discovery = discovery;
        this.configSource = configSource;
        this.lifetime = lifetime;
        this.health = health;
        this.pduApi = pduApi;
    }

    /// <summary>Authentication is turned off entirely (Gui.AuthType = None).</summary>
    private bool AuthDisabled => config.Gui.AuthType == GuiAuthType.None;

    /// <summary>OIDC is selected and the minimum settings (authority + client id) are present.</summary>
    private bool UseOidc => config.Gui.AuthType == GuiAuthType.Oidc
        && !string.IsNullOrWhiteSpace(config.Gui.Oidc.Authority)
        && !string.IsNullOrWhiteSpace(config.Gui.Oidc.ClientId);

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        var gui = config.Gui;
        if (!gui.Enabled)
            return;

        if (AuthDisabled)
        {
            Log.Warning("GUI authentication is DISABLED (Gui.AuthType = None). Anyone who can reach the GUI port has full access — only do this on a trusted, isolated network.");
        }
        else if (gui.AuthType == GuiAuthType.Oidc && !UseOidc)
        {
            Log.Error("Gui.AuthType is Oidc but Gui.Oidc.Authority/ClientId are not set. The GUI will not start.");
            return;
        }
        else if (gui.AuthType == GuiAuthType.Basic && string.IsNullOrWhiteSpace(gui.Password))
        {
            Log.Error("Gui.AuthType is Basic but Gui.Password is not set. The GUI will not start.");
            return;
        }

        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { Args = Array.Empty<string>() });
        builder.Logging.ClearProviders();
        builder.WebHost.UseUrls($"http://*:{gui.Port}");

        if (UseOidc)
            ConfigureOidc(builder, gui.Oidc);

        app = builder.Build();

        if (UseOidc)
        {
            // The GUI typically runs behind an ingress/gateway terminating TLS; honor the forwarded
            // scheme/host so OIDC builds the correct (https) redirect_uri.
            var fwd = new ForwardedHeadersOptions { ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto | ForwardedHeaders.XForwardedHost };
            fwd.KnownNetworks.Clear();
            fwd.KnownProxies.Clear();
            app.UseForwardedHeaders(fwd);

            app.UseAuthentication();
            app.UseAuthorization();
        }
        else if (!AuthDisabled)
        {
            app.Use(AuthMiddleware);
        }

        MapEndpoints(app);

        await app.StartAsync(cancellationToken);
        var how = AuthDisabled ? "no authentication" : UseOidc ? $"OIDC via {gui.Oidc.Authority}" : $"user '{gui.Username}'";
        Log.Information($"Configuration GUI listening on http://*:{gui.Port} ({how}).");
    }

    /// <summary>Wire cookie + OpenID Connect authentication and require an authenticated user.</summary>
    private static void ConfigureOidc(WebApplicationBuilder builder, OidcConfig oidc)
    {
        builder.Services.AddAuthentication(o =>
        {
            o.DefaultScheme = CookieAuthenticationDefaults.AuthenticationScheme;
            o.DefaultChallengeScheme = OpenIdConnectDefaults.AuthenticationScheme;
        })
        .AddCookie()
        .AddOpenIdConnect(o =>
        {
            o.Authority = oidc.Authority;
            o.ClientId = oidc.ClientId;
            o.ClientSecret = oidc.ClientSecret;
            o.ResponseType = "code";
            // Code flow defaults to form_post (a cross-site POST callback), on which SameSite=Lax
            // cookies aren't sent -> "Correlation failed". Use query so the callback is a top-level
            // GET; PKCE (on by default) keeps the code exchange safe.
            o.ResponseMode = "query";
            o.UsePkce = true;
            o.CallbackPath = oidc.CallbackPath;
            o.SaveTokens = true;
            o.GetClaimsFromUserInfoEndpoint = true;
            o.Scope.Clear();
            foreach (var scope in (oidc.Scopes ?? "openid profile email").Split(' ', StringSplitOptions.RemoveEmptyEntries))
                o.Scope.Add(scope);

            // Some providers (e.g. Authentik with no signing certificate) sign the id_token with
            // HS256, whose key isn't published in JWKS. Offer the client secret as a symmetric key so
            // those tokens validate; RS256 tokens still use the JWKS keys from discovery.
            if (!string.IsNullOrEmpty(oidc.ClientSecret))
                o.TokenValidationParameters.IssuerSigningKey =
                    new Microsoft.IdentityModel.Tokens.SymmetricSecurityKey(Encoding.UTF8.GetBytes(oidc.ClientSecret));

            // The default correlation/nonce cookies are SameSite=None, which browsers drop without
            // Secure (e.g. plain-http localhost). Lax + SameAsRequest works over http locally and
            // https behind a TLS-terminating ingress (the code flow's callback is a top-level GET).
            o.CorrelationCookie.SameSite = SameSiteMode.Lax;
            o.CorrelationCookie.SecurePolicy = CookieSecurePolicy.SameAsRequest;
            o.NonceCookie.SameSite = SameSiteMode.Lax;
            o.NonceCookie.SecurePolicy = CookieSecurePolicy.SameAsRequest;

            // Surface the real reason instead of a bare 500 on a failed callback.
            o.Events.OnRemoteFailure = ctx =>
            {
                Log.Error(ctx.Failure, $"OIDC sign-in failed: {ctx.Failure?.Message}");
                ctx.HandleResponse();
                ctx.Response.StatusCode = StatusCodes.Status400BadRequest;
                ctx.Response.ContentType = "text/plain";
                return ctx.Response.WriteAsync($"OIDC sign-in failed: {ctx.Failure?.Message}. See the bridge logs for details.");
            };
            o.Events.OnAuthenticationFailed = ctx =>
            {
                Log.Error(ctx.Exception, "OIDC authentication failed.");
                return Task.CompletedTask;
            };
        });

        // Everything requires an authenticated user unless explicitly AllowAnonymous.
        builder.Services.AddAuthorizationBuilder()
            .SetFallbackPolicy(new AuthorizationPolicyBuilder().RequireAuthenticatedUser().Build());
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
        app.MapGet("/styles.css", () => Results.Content(LoadAsset("styles.css") ?? "", "text/css"));
        app.MapGet("/app.js", () => Results.Content(LoadAsset("app.js") ?? "", "text/javascript"));

        // OIDC sign-out (clears the local cookie and ends the IdP session).
        if (UseOidc)
            app.MapGet("/logout", async (HttpContext ctx) =>
            {
                await ctx.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme);
                await ctx.SignOutAsync(OpenIdConnectDefaults.AuthenticationScheme);
            });

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

        app.MapGet("/api/status", (HttpContext ctx) => Results.Json(new
        {
            version = Version,
            configSource = configSource.Describe,
            configWritable = configSource.CanWrite,
            gitops = configSource.IsGitOpsManaged,
            mqttConnected = mqtt.IsConnected(),
            mqttHost = $"{mqtt.Options.Host}:{mqtt.Options.Port}",
            actionsEnabled = config.PDU.ActionsEnabled,
            auth = AuthDisabled ? "none" : UseOidc ? "oidc" : "basic",
            user = UseOidc ? ctx.User?.Identity?.Name : null,
        }, ConfigSchema.Json));

        // Diagnostics: versions, uptime, runtime, and Kubernetes context for the Diagnostics page.
        app.MapGet("/api/diagnostics", () =>
        {
            var k8s = configSource as KubernetesConfigSource;
            return Results.Json(new
            {
                ok = true,
                version = Version,
                image = Environment.GetEnvironmentVariable("RPDU2MQTT_IMAGE"),
                dotnet = Environment.Version.ToString(),
                os = RuntimeInformation.OSDescription,
                startedUtc = health.StartedUtc,
                uptimeSeconds = (long)health.Uptime.TotalSeconds,
                mqttConnected = mqtt.IsConnected(),
                mqttHost = $"{mqtt.Options.Host}:{mqtt.Options.Port}",
                configSource = configSource.Describe,
                lastPollUtc = health.LastPollUtc,
                kubernetes = k8s is not null,
                pod = Environment.GetEnvironmentVariable("RPDU2MQTT_POD_NAME"),
                ns = k8s?.Namespace,
            }, ConfigSchema.Json);
        });

        // Stop the app so the container/host restarts it (same mechanism as the HA Restart button).
        app.MapPost("/api/restart", () =>
        {
            Log.Information("Restart requested via GUI; stopping application.");
            // Let the HTTP response flush before the host shuts down.
            _ = Task.Run(async () => { await Task.Delay(300); lifetime.StopApplication(); });
            return Results.Json(new { ok = true, message = "Restarting…" }, ConfigSchema.Json);
        });

        // Tail of this pod's container logs (Kubernetes config source only).
        app.MapGet("/api/diagnostics/logs", async (HttpContext ctx) =>
        {
            if (configSource is not KubernetesConfigSource k8s)
                return Results.Json(new { ok = false, message = "Logs are only available with the Kubernetes config source." }, ConfigSchema.Json);
            var pod = Environment.GetEnvironmentVariable("RPDU2MQTT_POD_NAME");
            if (string.IsNullOrEmpty(pod))
                return Results.Json(new { ok = false, message = "Pod name unavailable (RPDU2MQTT_POD_NAME not set)." }, ConfigSchema.Json);
            try
            {
                using var stream = await k8s.Client.CoreV1.ReadNamespacedPodLogAsync(pod, k8s.Namespace, tailLines: 200, cancellationToken: ctx.RequestAborted);
                using var reader = new StreamReader(stream);
                return Results.Json(new { ok = true, logs = await reader.ReadToEndAsync(ctx.RequestAborted) }, ConfigSchema.Json);
            }
            catch (Exception ex)
            {
                return Results.Json(new { ok = false, message = $"Could not read pod logs: {ex.Message}" }, ConfigSchema.Json);
            }
        });

        // Recent Kubernetes events for this pod (Kubernetes config source only).
        app.MapGet("/api/diagnostics/events", async (HttpContext ctx) =>
        {
            if (configSource is not KubernetesConfigSource k8s)
                return Results.Json(new { ok = false, message = "Events are only available with the Kubernetes config source." }, ConfigSchema.Json);
            try
            {
                var pod = Environment.GetEnvironmentVariable("RPDU2MQTT_POD_NAME");
                var list = await k8s.Client.CoreV1.ListNamespacedEventAsync(k8s.Namespace,
                    fieldSelector: string.IsNullOrEmpty(pod) ? null : $"involvedObject.name={pod}", cancellationToken: ctx.RequestAborted);
                var events = list.Items
                    .Select(e => new
                    {
                        time = e.LastTimestamp ?? e.EventTime ?? e.Metadata?.CreationTimestamp,
                        type = e.Type,
                        reason = e.Reason,
                        message = e.Message,
                        count = e.Count,
                    })
                    .OrderByDescending(e => e.time)
                    .Take(50)
                    .ToList();
                return Results.Json(new { ok = true, events }, ConfigSchema.Json);
            }
            catch (Exception ex)
            {
                return Results.Json(new { ok = false, message = $"Could not read events: {ex.Message}" }, ConfigSchema.Json);
            }
        });

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
                var readingList = MetricsHelper.EnumerateReadings(data)
                    .OrderBy(r => r.Device).ThenBy(r => r.Source).ThenBy(r => r.Type)
                    .ToList();

                var readings = readingList
                    .Select(r => new { device = r.Device, source = r.Source, type = r.Type, value = r.Value, units = r.Units })
                    .ToList();

                // Pivoted view: one row per outlet/entity with its measurements as columns + state.
                var types = readingList.Select(r => r.Type).Distinct(StringComparer.OrdinalIgnoreCase).OrderBy(t => t).ToList();
                var units = readingList.GroupBy(r => r.Type, StringComparer.OrdinalIgnoreCase)
                    .ToDictionary(g => g.Key, g => g.Select(r => r.Units).FirstOrDefault(u => !string.IsNullOrEmpty(u)) ?? "", StringComparer.OrdinalIgnoreCase);

                var entities = new List<object>();
                foreach (var device in data.Devices)
                {
                    foreach (var o in device.Outlets.OrderBy(o => o.Key))
                        entities.Add(BuildLiveEntity(device.Entity_DisplayName, o.Entity_DisplayName, "outlet", o.Key + 1,
                            pdu.ResolveOutletState(device.Key, o.Key, o.State), o.Measurements));
                    foreach (var e in device.Entity)
                        entities.Add(BuildLiveEntity(device.Entity_DisplayName, e.Entity_DisplayName, "entity", null, null, e.Measurements));
                }

                return Results.Json(new { ok = true, count = readings.Count, readings, entities, types, units }, ConfigSchema.Json);
            }
            catch (Exception ex)
            {
                return Results.Json(new { ok = false, message = $"Could not read live PDU data: {ex.Message}" }, ConfigSchema.Json);
            }
        });

        // Generated integration paths per measurement (MQTT topic, Prometheus metric, EmonCMS key),
        // reflecting the current overrides — for the GUI "Paths" view.
        app.MapGet("/api/paths", async (HttpContext ctx) =>
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ctx.RequestAborted);
            cts.CancelAfter(TimeSpan.FromSeconds(20));
            try
            {
                var data = await pdu.GetRootData_Public(cts.Token);
                return Results.Json(BuildPaths(data, config), ConfigSchema.Json);
            }
            catch (Exception ex)
            {
                return Results.Json(new { ok = false, message = $"Could not read live PDU data: {ex.Message}" }, ConfigSchema.Json);
            }
        });

        // Preview the generated paths with the posted (unsaved) config applied, so the Overrides
        // editor can show how edits change the HA/Prometheus/EmonCMS paths. Runs the real processing
        // pipeline against a transient PDU so the result matches what would actually be published.
        app.MapPost("/api/paths/preview", async (HttpContext ctx) =>
        {
            using var reader = new StreamReader(ctx.Request.Body);
            var json = await reader.ReadToEndAsync();

            Config parsed;
            try { parsed = ConfigSchema.FromJson(json); }
            catch (Exception ex) { return Results.BadRequest(new { ok = false, message = $"Invalid configuration: {ex.Message}" }); }

            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ctx.RequestAborted);
            cts.CancelAfter(TimeSpan.FromSeconds(20));
            try
            {
                var data = await new PDU(parsed, pduApi).GetRootData_Public(cts.Token);
                return Results.Json(BuildPaths(data, parsed), ConfigSchema.Json);
            }
            catch (Exception ex)
            {
                return Results.Json(new { ok = false, message = $"Could not compute paths: {ex.Message}" }, ConfigSchema.Json);
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
                    // Resolve through the pending-write latch so a value just set here shows
                    // immediately instead of reverting until the PDU/poll catches up.
                    label = pdu.ResolveOutletConfig(d.Key, o.Key, "label", o.Label ?? ""),
                    state = pdu.ResolveOutletState(d.Key, o.Key, o.State),
                    onDelay = pdu.ResolveOutletConfig(d.Key, o.Key, "onDelay", o.OnDelay.ToString()),
                    offDelay = pdu.ResolveOutletConfig(d.Key, o.Key, "offDelay", o.OffDelay.ToString()),
                    rebootDelay = pdu.ResolveOutletConfig(d.Key, o.Key, "rebootDelay", o.RebootDelay.ToString()),
                    poaAction = pdu.ResolveOutletConfig(d.Key, o.Key, "poaAction", o.PoaAction ?? ""),
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

        // Write an outlet's label on the PDU itself (cmd "set"). Gated by PDU.ActionsEnabled.
        app.MapPost("/api/control/label", async (HttpContext ctx) =>
        {
            if (!config.PDU.ActionsEnabled)
                return Results.Json(new { ok = false, message = "Write actions are disabled (PDU.ActionsEnabled is false)." }, statusCode: 409);

            LabelRequest? req;
            try { req = await ctx.Request.ReadFromJsonAsync<LabelRequest>(ctx.RequestAborted); }
            catch { req = null; }
            if (req is null || string.IsNullOrWhiteSpace(req.DeviceId))
                return Results.BadRequest(new { ok = false, message = "deviceId, index and label are required." });

            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ctx.RequestAborted);
            cts.CancelAfter(TimeSpan.FromSeconds(20));
            try
            {
                await pdu.SetOutletConfigAsync(req.DeviceId, req.Index, new Dictionary<string, object> { ["label"] = (req.Label ?? string.Empty).Trim() }, cts.Token);
                return Results.Json(new { ok = true, message = $"Outlet {req.Index + 1} label set." }, ConfigSchema.Json);
            }
            catch (Exception ex)
            {
                return Results.Json(new { ok = false, message = $"Set label failed: {ex.Message}" }, ConfigSchema.Json);
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

    /// <summary>Body of a POST /api/control/label request.</summary>
    private sealed record LabelRequest(string DeviceId, int Index, string Label);

    /// <summary>One pivoted live-view row: an outlet/entity with its numeric measurements + state.</summary>
    private static object BuildLiveEntity(string device, string source, string kind, int? number, string? state, IEnumerable<Models.PDU.Measurement> measurements)
    {
        var values = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);
        foreach (var m in measurements)
            if (!string.IsNullOrEmpty(m.Type) && double.TryParse(m.Value, System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out var v))
                values[m.Type] = v;
        return new { device, source, kind, number, state, values };
    }

    /// <summary>Project a poll's measurements into the generated MQTT/Prometheus/EmonCMS paths.</summary>
    private static object BuildPaths(Models.PDU.PduData data, Config config)
    {
        var promEnabled = config.Prometheus.Exporter || config.Prometheus.Pushgateway.Enabled;
        var emonEnabled = config.EmonCMS.Enabled;
        var rows = MetricsHelper.EnumerateReadings(data)
            .OrderBy(r => r.Device).ThenBy(r => r.Source).ThenBy(r => r.Type)
            .Select(r => new
            {
                device = r.Device,
                source = r.Source,
                type = r.Type,
                mqtt = r.Topic,
                prometheus = promEnabled ? $"{MetricsHelper.PrometheusMetricName(r, config)}{{device=\"{r.Device}\",source=\"{r.Source}\"}}" : null,
                emoncms = emonEnabled ? $"node={config.EmonCMS.Node} key={r.Identifier}" : null,
            })
            .ToList();
        return new { ok = true, prometheusEnabled = promEnabled, emonEnabled, count = rows.Count, rows };
    }

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
        => LoadAsset("index.html") ?? "<html><body><h1>rPDU2MQTT</h1><p>GUI assets missing.</p></body></html>";

    /// <summary>Read an embedded wwwroot asset by file-name suffix (e.g. "app.js").</summary>
    private static string? LoadAsset(string endsWith)
    {
        var asm = Assembly.GetExecutingAssembly();
        var name = asm.GetManifestResourceNames().FirstOrDefault(n => n.EndsWith(endsWith, StringComparison.OrdinalIgnoreCase));
        if (name is null)
            return null;

        using var stream = asm.GetManifestResourceStream(name)!;
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }
}
