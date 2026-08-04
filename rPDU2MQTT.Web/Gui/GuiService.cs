using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using HiveMQtt.Client;
using HiveMQtt.MQTT5.Types;
using k8s;
using k8s.Models;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.DataProtection;
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
using rPDU2MQTT.Core.Flow;
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
    private readonly PduInstanceFactory pduFactory;
    private readonly PduInstanceRegistry registry;
    private readonly InstanceManager instances;
    private readonly EmonCmsStatus emonCmsStatus;
    private readonly Core.IProcessRestarter? restarter;
    private readonly Core.ISnapshotCache snapshots;
    private readonly Core.HostRole hostRoles;
    private readonly HaEnergyDashboardSync haEnergy;
    private readonly Core.Flow.IFlowValueSource? live;
    private static readonly HttpClient testHttp = new() { Timeout = TimeSpan.FromSeconds(15) };
    private WebApplication? app;
    // Created on the first /api/events connection; the pump only runs while a tab is watching.
    private GuiEventHub? events;
    private readonly object eventsGate = new();

    private readonly Orleans.IGrainFactory grains;

    public GuiService(Config config, IHiveMQClient mqtt, PDU pdu, DiscoveryCoordinator discovery, IConfigSource configSource, IHostApplicationLifetime lifetime, HealthState health, PduInstanceFactory pduFactory, PduInstanceRegistry registry, InstanceManager instances, EmonCmsStatus emonCmsStatus, Core.ISnapshotCache snapshots, Core.HostRole hostRoles, HaEnergyDashboardSync haEnergy, Orleans.IGrainFactory grains, Core.Flow.IFlowValueSource? live = null, Core.IProcessRestarter? restarter = null)
    {
        this.live = live;
        this.grains = grains;
        this.config = config;
        this.mqtt = mqtt;
        this.pdu = pdu;
        this.discovery = discovery;
        this.configSource = configSource;
        this.lifetime = lifetime;
        this.health = health;
        this.pduFactory = pduFactory;
        this.registry = registry;
        this.instances = instances;
        this.emonCmsStatus = emonCmsStatus;
        this.restarter = restarter;
        this.snapshots = snapshots;
        this.hostRoles = hostRoles;
        this.haEnergy = haEnergy;
    }

    /// <summary>
    /// Current data for an instance, preferring the shared snapshot cache (filled by the local poller, or
    /// by the MQTT bus bridge on a consumer-only node) and falling back to a direct poll when the cache is
    /// still cold. This is the read seam that lets a UI/API role serve a worker's data without polling.
    /// </summary>
    private async Task<Models.PDU.PduData> ResolveData(string id, PDU pdu, CancellationToken ct) =>
        snapshots.Get(id)?.Data ?? await pdu.GetRootData_Public(ct);

    /// <summary>The instance id a request targets — a usable (registry) instance, else the primary's.</summary>
    private string ResolveInstanceId(string? requested) =>
        !string.IsNullOrEmpty(requested) && registry.All.ContainsKey(requested)
            ? requested
            : (registry.All.ContainsKey(Config.DefaultInstanceKey) ? Config.DefaultInstanceKey : registry.All.Keys.First());

    /// <summary>Resolve the PDU + its config for a request, from <c>?instance=</c> (GET) or a body field (POST).</summary>
    private (string Id, PDU Pdu, Models.Config.PduConfig Cfg) ResolveInstance(string? requested)
    {
        var id = ResolveInstanceId(requested);
        return (id, registry.Get(id), config.Pdus[id]);
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
        // Kestrel's default 32 KB request-header cap returns 431 once cookies pile up — OIDC session/nonce
        // cookies, plus anything set across sibling *.<domain> subdomains that all get sent here. Give it room
        // so a browser carrying a fat cookie jar can still reach the GUI.
        builder.WebHost.ConfigureKestrel(k => k.Limits.MaxRequestHeadersTotalSize = 64 * 1024);

        // Before auth is wired: the cookie handler takes the key ring as it is at build time, so persisting
        // it afterwards would have no effect on the cookies actually issued.
        // Basic auth has no cookie, so this only matters for OIDC — but it costs nothing and the GUI may be
        // switched to OIDC later without anyone revisiting this.
        ConfigureDataProtection(builder);

        if (UseOidc)
            ConfigureOidc(builder, gui.Oidc);

        app = builder.Build();

        if (UseOidc)
        {
            // The GUI typically runs behind an ingress/gateway terminating TLS; honor the forwarded
            // scheme/host so OIDC builds the correct (https) redirect_uri.
            var fwd = new ForwardedHeadersOptions { ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto | ForwardedHeaders.XForwardedHost };
            fwd.KnownIPNetworks.Clear();
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

    /// <summary>
    /// Keep the key that encrypts auth cookies across restarts.
    ///
    /// <para>
    /// ASP.NET Core generates a data-protection key ring in memory at startup unless told where to keep it.
    /// Every restart therefore mints a new one, the cookie the previous process issued can no longer be
    /// decrypted, and the browser is bounced back to the identity provider — so every deploy, every config
    /// change that restarts the pod, meant signing in again. It was never the IdP or the cookie lifetime:
    /// the key that could read the cookie had been thrown away.
    /// </para>
    /// <para>
    /// Valkey/Redis when it is configured, because that also makes a session valid on <em>any</em> replica —
    /// without a shared ring, a session only works on the pod that issued it, so scaling out logs people out
    /// at random. A local directory otherwise, which survives a process restart but not a container that
    /// keeps no volume; that is said out loud rather than left to be discovered.
    /// </para>
    /// <para>
    /// The application name is pinned. It is part of the key derivation, so letting it default to the entry
    /// assembly would silently invalidate every existing cookie the day the assembly is renamed.
    /// </para>
    /// </summary>
    private void ConfigureDataProtection(WebApplicationBuilder builder)
    {
        var keys = builder.Services.AddDataProtection().SetApplicationName("rPDU2MQTT");

        if (config.Cache.Enabled && !string.IsNullOrWhiteSpace(config.Cache.Connection))
        {
            try
            {
                var options = StackExchange.Redis.ConfigurationOptions.Parse(config.Cache.Connection);
                options.AbortOnConnectFail = false;
                if (!string.IsNullOrWhiteSpace(config.Cache.Password)) options.Password = config.Cache.Password;
                options.ConnectTimeout = Math.Max(1, config.Cache.ConnectTimeoutSeconds) * 1000;

                var redis = StackExchange.Redis.ConnectionMultiplexer.Connect(options);
                keys.PersistKeysToStackExchangeRedis(redis, (config.Cache.KeyPrefix ?? "") + "dataprotection-keys");
                Log.Information("Sign-in keys are kept in the cache, so a restart does not sign everyone out.");
                return;
            }
            catch (Exception ex)
            {
                // Falling through to disk is better than refusing to start the GUI; say why, because the
                // symptom otherwise is "I have to log in again" with nothing to connect it to.
                Log.Warning($"Could not keep sign-in keys in the cache ({ex.Message}); falling back to local disk. "
                          + "Sessions will not survive a container that keeps no volume, or move between replicas.");
            }
        }

        var dir = new DirectoryInfo(Path.Combine(Path.GetTempPath(), "rpdu2mqtt-keys"));
        try
        {
            dir.Create();
            keys.PersistKeysToFileSystem(dir);
            Log.Information($"Sign-in keys are kept in {dir.FullName}. Enable Cache (Redis/Valkey) to keep them "
                          + "across container restarts and share them between replicas.");
        }
        catch (Exception ex)
        {
            Log.Warning($"Sign-in keys could not be persisted ({ex.Message}); every restart will require signing in again.");
        }
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
        // Stop pushing before the host goes down, so open SSE connections end cleanly.
        if (events is not null)
            await events.DisposeAsync();

        if (app is not null)
            await app.StopAsync(cancellationToken);
    }

    public async ValueTask DisposeAsync()
    {
        if (events is not null)
            await events.DisposeAsync();

        if (app is not null)
            await app.DisposeAsync();
    }

    /// <summary>
    /// The push hub, built on the first /api/events connection so nothing runs in a GUI nobody has opened.
    /// Each feed is one of the payload builders below on its own cadence — see <see cref="GuiEventHub"/>.
    /// </summary>
    private GuiEventHub EventHub()
    {
        lock (eventsGate)
            return events ??= new GuiEventHub(ConfigSchema.Json,
                // The header: version, MQTT, config writability, operator update. The operator report is a
                // Kubernetes read, so this is the slowest feed.
                new GuiEventHub.Feed("status", TimeSpan.FromSeconds(5), (_, ct) => BuildStatusAsync(null, ct)),
                // The Status board's cards, straight from the component grains.
                new GuiEventHub.Feed("board", TimeSpan.FromSeconds(3), (_, _) => BuildBoardAsync()),
                // Readings for one instance ("livedata:<instance>"; bare "livedata" = the primary).
                new GuiEventHub.Feed("livedata", TimeSpan.FromSeconds(2), BuildLiveDataAsync),
                // The energy-flow graph, keyed "flow:<metric>" or "flow:<metric>|<instance>".
                new GuiEventHub.Feed("flow", TimeSpan.FromSeconds(2), (arg, ct) =>
                {
                    var parts = (arg ?? "").Split('|');
                    return BuildFlowAsync(parts.Length > 1 ? parts[1] : null, parts[0], ct);
                }));
    }

    // --- Payload builders --------------------------------------------------------------------------
    // Shared by the REST endpoints and the /api/events push feeds, so both always describe the same
    // thing: a feed is literally the endpoint's body, recomputed on a timer and sent only when it moves.

    /// <summary>Header state: version, config source/writability, MQTT, and the operator's update report.</summary>
    private async Task<object> BuildStatusAsync(string? user, CancellationToken ct) => new
    {
        version = Version,
        configSource = configSource.Describe,
        configWritable = configSource.CanWrite,
        gitops = configSource.IsGitOpsManaged,
        mqttConnected = mqtt.IsConnected(),
        mqttHost = $"{mqtt.Options.Host}:{mqtt.Options.Port}",
        actionsEnabled = config.Primary.ActionsEnabled,
        auth = AuthDisabled ? "none" : UseOidc ? "oidc" : "basic",
        showProjectLink = config.Gui.ShowProjectLink,
        user,
        // Operator update state (#210) for the header indicator; null when no operator is reporting.
        update = await ReadOperatorUpdateAsync(configSource as KubernetesConfigSource, ct),
    };

    /// <summary>
    /// The Status board (v3): every hop's card as its own component grain computed it. The verdicts —
    /// connected/stale/waiting, and what colour that is — belong to the components, so this just hands the
    /// board over. One grain call, one cluster-wide answer, whichever replica serves the request.
    /// </summary>
    /// <summary>
    /// Retained discovery configs under our own device-id prefix that this build would not publish today.
    ///
    /// <para>
    /// Built by asking the broker what is actually retained and subtracting what the exporter means to
    /// publish. That subtraction is the only way to find them: the publish loop walks the nodes that exist
    /// now, so a config for something that no longer exists is unreachable from it by construction.
    /// </para>
    /// </summary>
    private async Task<IReadOnlyList<string>> OrphanedDiscoveryAsync()
    {
        var prefix = config.HASS.DiscoveryTopic;
        if (string.IsNullOrWhiteSpace(prefix)) return Array.Empty<string>();

        var index = grains.GetGrain<Grains.Abstractions.Discovery.ITopicIndexGrain>(0);
        await index.Renew(prefix.Trim().Trim('/') + "/#");
        var retained = (await index.Search(null, 5000)).Select(t => t.Topic).ToList();

        // What the exporter would publish right now: every non-synthetic tier that is NOT already covered by
        // native PDU discovery. Anything else carrying our prefix is a leftover.
        var merged = new Models.PDU.PduData();
        foreach (var s in snapshots.All) merged.Devices.AddRange(s.Data.Devices);

        var energyMetric = string.IsNullOrWhiteSpace(config.HASS.EnergyDashboard.EnergyMeasurementType)
            ? "energy" : config.HASS.EnergyDashboard.EnergyMeasurementType;
        var graph = Core.Flow.FlowGraphBuilder.Build(merged, config.EnergyFlow, Core.Flow.FlowGraphBuilder.DefaultMetric, live);
        var native = Core.Flow.FlowExport.NativeEnergyUniqueIds(merged, energyMetric);

        var current = graph.Nodes
            .Where(n => !n.Synthetic && !native.ContainsKey(n.Id))
            .Select(n => Core.Flow.FlowExport.DeviceId(n.Id));

        return Core.Flow.FlowExport.OrphanedDiscoveryTopics(retained, current, prefix);
    }

    private async Task<object> BuildBoardAsync()
    {
        try
        {
            var board = await grains.GetGrain<Grains.Abstractions.Status.IStatusBoardGrain>(0).Board();
            var cards = board.Select(c => new
            {
                id = c.Id,
                title = c.Title,
                level = c.Level.ToString().ToLowerInvariant(),
                state = c.State,
                detail = c.Detail,
                eventUtc = c.EventUtc,
                age = c.Age.ToString().ToLowerInvariant(),
            }).ToArray();
            return new { ok = true, cards };
        }
        catch (Exception ex) { return new { ok = false, message = ex.Message }; }
    }

    /// <summary>Current readings for one instance, both flat and pivoted, plus OneView group rollups.</summary>
    private async Task<object> BuildLiveDataAsync(string? instance, CancellationToken ct)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(TimeSpan.FromSeconds(20));
        try
        {
            var (id, pdu, _) = ResolveInstance(instance);
            var data = await ResolveData(id, pdu, cts.Token);
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

            // OneView group rollups (Sum/Avg/Min/Max per measurement type). The group's aggregate
            // measurements live on its single synthetic outlet (normal groups) or pduTotal (the Total group).
            var groups = data.Groups.Select(g =>
            {
                var src = g.Entity?.Outlets?.FirstOrDefault()?.Measurements
                          ?? g.Entity?.PduTotal?.FirstOrDefault()?.Measurements
                          ?? new List<Models.PDU.GroupMeasurement>();
                var measurements = src.Where(m => !string.IsNullOrEmpty(m.Type)).Select(m => new
                {
                    type = m.Type,
                    units = m.Units,
                    sum = ParseMeasure(m.SumValue),
                    avg = ParseMeasure(m.AvgValue),
                    min = ParseMeasure(m.MinValue),
                    max = ParseMeasure(m.MaxValue),
                }).ToList();
                return new { name = g.Entity_DisplayName, measurements };
            }).Where(g => g.measurements.Count > 0).ToList();

            return new { ok = true, count = readings.Count, readings, entities, groups, types, units };
        }
        catch (Exception ex)
        {
            return new { ok = false, message = $"Could not read live PDU data: {ex.Message}" };
        }
    }

    /// <summary>The energy-flow graph for one instance + metric (the Sankey / Energy Overview source).</summary>
    private async Task<object> BuildFlowAsync(string? instance, string? metric, CancellationToken ct)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(TimeSpan.FromSeconds(20));
        try
        {
            var (id, pdu, _) = ResolveInstance(instance);
            var data = await ResolveData(id, pdu, cts.Token);
            var graph = FlowGraphBuilder.Build(data, config.EnergyFlow, string.IsNullOrEmpty(metric) ? FlowGraphBuilder.DefaultMetric : metric, live);
            return new { ok = true, graph.Nodes, graph.Links, graph.Metric, graph.Units };
        }
        catch (Exception ex)
        {
            return new { ok = false, message = $"Could not build flow graph: {ex.Message}" };
        }
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

        app.MapGet("/api/schema", () =>
        {
            var schema = ConfigSchema.Build();
            // Under Kubernetes, logging is driven by the platform (stdout + the pod spec), so the Logging
            // config section doesn't apply — drop it from the GUI schema (#209).
            if (configSource is KubernetesConfigSource)
                schema = schema.Where(n => n.Key != "Logging").ToList();
            return Results.Json(schema, ConfigSchema.Json);
        });

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

                // Re-read the just-saved config so live-readable settings take effect without a restart.
                var reloaded = configSource.Load();
                // The energy-flow hierarchy is read fresh on every /api/flow request, so applying it here
                // makes Flow/Sankey edits show up on the next refresh (previously they needed a restart).
                config.EnergyFlow = reloaded.EnergyFlow;
                // Likewise the HA Energy-Dashboard settings (URL/token/enable), so the periodic sync toggle
                // and the manual sync/clear buttons pick up edits without a restart.
                config.HASS.EnergyDashboard = reloaded.HASS.EnergyDashboard;
                // And the EmonCMS feed-provisioning settings, so AutoConfigure + the per-type feed config
                // take effect on the next provisioning pass without a restart (#163).
                config.EmonCMS.Feeds = reloaded.EmonCMS.Feeds;

                // Apply PDU instance add/remove live: refresh the instance set from the saved config and
                // reconcile the running pollers (a new PDU starts polling, a removed one stops) without a
                // restart. Other live-read settings (overrides/names/templates) still apply on Republish.
                var instanceMessage = "";
                try
                {
                    config.Pdus = reloaded.Pdus;
                    await instances.ReconcileAsync();
                    instanceMessage = " PDU instances were applied live.";
                }
                catch (Exception ex)
                {
                    Log.Warning($"Could not reconcile PDU instances after save ({ex.Message}); a restart will apply them.");
                }

                var message = (configSource.IsGitOpsManaged
                    ? "Saved to the Kubernetes resource (remember to update your GitOps source so it doesn't drift). Credentials are stored in the companion Secret. Press 'Republish discovery' to apply override/name/template changes; restart for primary connection/credential changes (incl. OIDC)."
                    : "Saved. Press 'Republish discovery' to apply override/name/template changes; restart the service for primary connection changes (host/port).") + instanceMessage;
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

        // NOTE (and see the RouteHandlersReturnTheirResults test): a handler taking HttpContext must use a
        // statement body with `return`. An expression-bodied `async (HttpContext ctx) => Results.Json(...)`
        // also fits RequestDelegate (Func<HttpContext,Task>), which is the more specific MapGet overload —
        // so it wins, the IResult is discarded, and the endpoint answers 200 with an empty body.
        app.MapGet("/api/status", async (HttpContext ctx) =>
        {
            return Results.Json(await BuildStatusAsync(UseOidc ? ctx.User?.Identity?.Name : null, ctx.RequestAborted), ConfigSchema.Json);
        });

        // One push channel for the whole GUI (#281): the browser opens a single EventSource and names the
        // feeds it wants; the hub recomputes each only while something is watching, and only sends changes.
        app.MapGet("/api/events", (HttpContext ctx) => EventHub().StreamAsync(ctx, ctx.Request.Query["topics"].ToString()));

        // "Check now" from the header: the operator runs in a separate process, so ask it over the bus to
        // run an immediate registry check. It patches the CR status, which the header then re-reads.
        app.MapPost("/api/operator/check", async (HttpContext ctx) =>
        {
            if (configSource is not KubernetesConfigSource)
                return Results.Json(new { ok = false, message = "Update checks are only available with the Kubernetes config source." }, ConfigSchema.Json);
            try
            {
                var report = await grains.GetGrain<Grains.Abstractions.Operator.IOperatorGrain>(0).CheckNow(force: true);
                return Results.Json(new { ok = true, message = report.Message ?? "Checked.", update = report }, ConfigSchema.Json);
            }
            catch (Exception ex) { return Results.Json(new { ok = false, message = $"Could not request a check: {ex.Message}" }, ConfigSchema.Json); }
        });

        // Tags available for the deployed image, so the Operator page can offer a channel/version switch.
        // The GUI process queries the registry directly (a plain HTTPS call); the switch itself is the operator's job.
        app.MapGet("/api/operator/tags", async (HttpContext ctx) =>
        {
            if (configSource is not KubernetesConfigSource)
                return Results.Json(new { ok = false, message = "Switching versions needs the Kubernetes config source + the operator role." }, ConfigSchema.Json);
            if (!Updates.ImageReference.TryParse(Environment.GetEnvironmentVariable("RPDU2MQTT_IMAGE"), out var image))
                return Results.Json(new { ok = false, message = "The deployed image is unknown (RPDU2MQTT_IMAGE is unset)." }, ConfigSchema.Json);
            try
            {
                var host = image.Registry == Updates.ImageReference.DefaultRegistry ? "registry-1.docker.io" : image.Registry;
                var tags = await new Services.Operator.ContainerRegistryClient().ListTagsAsync(host, image.Repository, ctx.RequestAborted);
                // Offer the moving channels that actually exist, then release versions newest-first.
                var channels = new[] { "stable", "latest", "edge", "dev", "unstable" }.Where(tags.Contains).ToArray();
                var versions = tags.Where(t => Updates.SemVer.TryParse(t, out _))
                    .Select(t => { Updates.SemVer.TryParse(t, out var v); return (Tag: t, Ver: v!); })
                    .Where(x => !x.Ver.IsPreRelease)
                    .OrderByDescending(x => x.Ver).Select(x => x.Tag).Take(50).ToArray();
                return Results.Json(new { ok = true, current = image.Tag, registry = image.Registry, repository = image.Repository, channels, versions }, ConfigSchema.Json);
            }
            catch (Exception ex) { return Results.Json(new { ok = false, message = $"Could not list tags: {ex.Message}" }, ConfigSchema.Json); }
        });

        // Switch the deployed image tag (channel or version). The operator rolls the Deployment(s) to it.
        app.MapPost("/api/operator/set-tag", async (HttpContext ctx) =>
        {
            if (configSource is not KubernetesConfigSource)
                return Results.Json(new { ok = false, message = "Switching versions needs the Kubernetes config source + the operator role." }, ConfigSchema.Json);
            var tag = ctx.Request.Query["tag"].FirstOrDefault()?.Trim();
            if (string.IsNullOrWhiteSpace(tag))
                return Results.Json(new { ok = false, message = "A tag is required." }, ConfigSchema.Json);
            try
            {
                var msg = await grains.GetGrain<Grains.Abstractions.Operator.IOperatorGrain>(0).SetTag(tag);
                return Results.Json(new { ok = true, message = msg }, ConfigSchema.Json);
            }
            catch (Exception ex) { return Results.Json(new { ok = false, message = $"Could not request the switch: {ex.Message}" }, ConfigSchema.Json); }
        });

        // Force update: re-pull the currently-deployed tag now (the operator pins its current digest so it
        // rolls even under IfNotPresent). Useful for moving channels (edge/dev/stable) that changed underneath.
        app.MapPost("/api/operator/redeploy", async (HttpContext ctx) =>
        {
            if (configSource is not KubernetesConfigSource)
                return Results.Json(new { ok = false, message = "Force update needs the Kubernetes config source + the operator role." }, ConfigSchema.Json);
            try
            {
                var msg = await grains.GetGrain<Grains.Abstractions.Operator.IOperatorGrain>(0).Redeploy();
                return Results.Json(new { ok = true, message = msg }, ConfigSchema.Json);
            }
            catch (Exception ex) { return Results.Json(new { ok = false, message = $"Could not request the update: {ex.Message}" }, ConfigSchema.Json); }
        });

        // Configured PDU instances (the per-tab instance selector on Live Data / Control reads this).
        app.MapGet("/api/instances", () =>
        {
            var primaryId = ResolveInstanceId(null);
            // Only usable (pollable) instances — registry skips entries missing a Connection.Host.
            var instances = registry.All.Keys.Select(id => new
            {
                id,
                primary = string.Equals(id, primaryId, StringComparison.OrdinalIgnoreCase),
                actionsEnabled = config.Pdus.TryGetValue(id, out var c) && c.ActionsEnabled,
            }).ToList();
            return Results.Json(new { ok = true, instances }, ConfigSchema.Json);
        });

        // What time the SERVER thinks it is, and when the energy day next rolls over.
        //
        // Both halves are things you cannot check from a browser: the clock the daily totals are cut on is
        // the container's, not yours, and a container's is UTC unless someone set TZ. Reading "Energy today"
        // without knowing that is how you conclude the numbers are wrong when the day simply ended at 7pm.
        // Computed from config rather than from the accumulator, so it answers on every role and still
        // answers when period tracking is off — "off" is itself the thing worth seeing.
        app.MapGet("/api/time", () =>
        {
            var agg = config.EnergyFlow.Aggregation;
            var now = DateTime.UtcNow;
            var configured = agg.PeriodTimeZone;
            // Resolve without warning: the log has already said so once at startup, and an endpoint polled
            // by a browser must not fill it up. `resolved` carries the same fact to the GUI instead.
            var zone = EnergyPeriod.Resolve(configured);
            var resolved = string.IsNullOrWhiteSpace(configured) || string.Equals(zone.Id, configured.Trim(), StringComparison.OrdinalIgnoreCase);
            var startHour = agg.PeriodStartHour is >= 0 and <= 23 ? agg.PeriodStartHour : 0;
            var next = EnergyPeriod.NextRollover(now, zone, startHour);

            return Results.Json(new
            {
                ok = true,
                utc = now,
                host = new
                {
                    zone = TimeZoneInfo.Local.Id,
                    offsetMinutes = (int)TimeZoneInfo.Local.GetUtcOffset(now).TotalMinutes,
                    time = EnergyPeriod.Local(now, TimeZoneInfo.Local),
                },
                period = new
                {
                    tracked = agg.TrackPeriods,
                    configured,
                    resolved,
                    zone = zone.Id,
                    offsetMinutes = (int)zone.GetUtcOffset(now).TotalMinutes,
                    startHour,
                    time = EnergyPeriod.Local(now, zone),
                    key = EnergyPeriod.KeyFor(now, zone, startHour),
                    nextRolloverUtc = next,
                    nextRolloverLocal = EnergyPeriod.Local(next, zone),
                    secondsUntilRollover = (int)Math.Max(0, (next - now).TotalSeconds),
                },
            }, ConfigSchema.Json);
        });

        // Ready-made energy-flow device templates the Nodes tab can import (EG4 inverters, meters, …).
        app.MapGet("/api/node-templates", () =>
            Results.Json(new { ok = true, templates = rPDU2MQTT.NodeTemplates.NodeTemplateCatalog.All }, ConfigSchema.Json));

        // The Status board (v3): every hop's card as its own component grain computed it. The verdicts —
        // connected/stale/waiting, and what colour that is — belong to the components, so this endpoint just
        // hands the board over. One grain call, one cluster-wide answer, whichever replica serves the request.
        app.MapGet("/api/status/board", async () => Results.Json(await BuildBoardAsync(), ConfigSchema.Json));

        // Diagnostics: versions, uptime, runtime, and Kubernetes context for the Diagnostics page.
        app.MapGet("/api/diagnostics", async (HttpContext ctx) =>
        {
            var k8s = configSource as KubernetesConfigSource;

            // Operator update report (#210), if the operator has written one to the CR status.
            var update = await ReadOperatorUpdateAsync(k8s, ctx.RequestAborted);

            // The cluster-wide process list (v3: the ProcessRegistryGrain, replacing the MQTT heartbeat).
            var processList = await grains.GetGrain<Grains.Abstractions.Diagnostics.IProcessRegistryGrain>(0).Active();

            // EmonCMS export health. The exporter runs only on the worker, so on a split API/UI node the local
            // status has never attempted an export — fall back to the worker's status carried on its process
            // registration, so the Status board shows the true state instead of a misleading "waiting".
            object? emonStatus = null;
            if (config.EmonCMS.Enabled)
            {
                if (emonCmsStatus.HasAttempted)
                    emonStatus = emonCmsStatus.Snapshot();
                else
                    emonStatus = processList
                        .Where(p => p.EmonCms is not null && (DateTime.UtcNow - p.TimestampUtc).TotalSeconds <= Grains.Abstractions.Diagnostics.IProcessRegistryGrain.StaleAfterSeconds)
                        .OrderByDescending(p => p.TimestampUtc)
                        .Select(p => (object?)p.EmonCms)
                        .FirstOrDefault() ?? emonCmsStatus.Snapshot();
            }

            // Modbus source health: for each configured connection, ask its device grain whether it's actually
            // being read — so "everything's green but no inverter data" is diagnosable, instead of the failure
            // living only in a log line while solar/battery/grid quietly read null.
            var modbus = new List<object>();
            foreach (var conn in config.Modbus.Connections)
            {
                if (!conn.Enabled || string.IsNullOrWhiteSpace(conn.Host)) continue;
                try
                {
                    var h = await grains.GetGrain<Grains.Abstractions.Modbus.IModbusGrain>(
                        Grains.Abstractions.Modbus.IModbusGrain.KeyFor(conn.Host, conn.Port, conn.UnitId)).Health();
                    long? okAge = h.LastOkUtc is { } okAt ? (long)Math.Max(0, (DateTime.UtcNow - okAt).TotalSeconds) : null;
                    var stale = h.LastOkUtc is null || (h.PollIntervalSeconds > 0 && okAge > Math.Max(30, h.PollIntervalSeconds * 3));
                    modbus.Add(new
                    {
                        id = conn.Id, name = conn.Name ?? conn.Id, host = $"{conn.Host}:{conn.Port}", unitId = conn.UnitId,
                        bindings = h.Bindings, values = h.LastValueCount, lastOkAgeSeconds = okAge, error = h.LastError, stale,
                    });
                }
                catch { /* device grain unreachable from here — leave it off rather than guess */ }
            }

            return Results.Json(new
            {
                ok = true,
                version = Version,
                image = Environment.GetEnvironmentVariable("RPDU2MQTT_IMAGE"),
                update,
                modbus,
                dotnet = Environment.Version.ToString(),
                os = RuntimeInformation.OSDescription,
                startedUtc = health.StartedUtc,
                uptimeSeconds = (long)health.Uptime.TotalSeconds,
                mqttConnected = mqtt.IsConnected(),
                mqttHost = $"{mqtt.Options.Host}:{mqtt.Options.Port}",
                configSource = configSource.Describe,
                lastPollUtc = health.LastPollUtc,
                // Component health: which workloads this process runs, and whether PDU data is flowing
                // (from the local poller, or a remote worker via the MQTT bus bridge).
                roles = Enum.GetValues<Core.HostRole>()
                    .Where(r => r is Core.HostRole.Worker or Core.HostRole.Api or Core.HostRole.Ui && hostRoles.HasFlag(r))
                    .Select(r => r.ToString().ToLowerInvariant())
                    .ToArray(),
                dataSources = snapshots.All
                    .OrderBy(s => s.InstanceId)
                    .Select(s =>
                    {
                        var interval = config.Pdus.TryGetValue(s.InstanceId, out var pc) ? pc.PollInterval : 30;
                        return new
                        {
                            instance = s.InstanceId,
                            ageSeconds = (long)Math.Max(0, (DateTime.UtcNow - s.TimestampUtc).TotalSeconds),
                            stale = Core.SnapshotFreshness.IsStale(s.TimestampUtc, interval, DateTime.UtcNow),
                        };
                    })
                    .ToArray(),
                // Other role processes in the cluster (split deployments). Empty for a single-node "all".
                processes = processList
                    .OrderBy(p => string.Join(',', p.Roles)).ThenBy(p => p.Host)
                    .Select(p =>
                    {
                        var age = (long)Math.Max(0, (DateTime.UtcNow - p.TimestampUtc).TotalSeconds);
                        return new
                        {
                            id = p.Id,
                            roles = p.Roles,
                            host = p.Host,
                            ageSeconds = age,
                            stale = age > Grains.Abstractions.Diagnostics.IProcessRegistryGrain.StaleAfterSeconds,
                        };
                    })
                    .ToArray(),
                kubernetes = k8s is not null,
                pod = Environment.GetEnvironmentVariable("RPDU2MQTT_POD_NAME"),
                ns = k8s?.Namespace,
                emoncms = config.EmonCMS.Enabled
                    ? new { enabled = true, transport = (string?)config.EmonCMS.Transport.ToString().ToLowerInvariant(), status = emonStatus }
                    : new { enabled = false, transport = (string?)null, status = (object?)null },
            }, ConfigSchema.Json);
        });

        // Grain diagnostics (v3): the live grain tree — every silo (pod), the grain types active on each, and
        // the current cluster leader. Uses Orleans' IManagementGrain, so it reflects the whole cluster from
        // whichever process serves the GUI. Fails soft (ok:false) if the management grain is unavailable.
        app.MapGet("/api/grains", async (HttpContext ctx) =>
        {
            try
            {
                var mgmt = grains.GetGrain<Orleans.Runtime.IManagementGrain>(0);
                var stats = await mgmt.GetSimpleGrainStatistics();
                var hosts = await mgmt.GetHosts(onlyActive: true);
                var leader = await grains.GetGrain<Grains.Abstractions.Cluster.ILeaderGrain>(0).CurrentLeader();

                var silos = hosts
                    .OrderBy(h => h.Key.ToParsableString())
                    .Select(h => new { silo = h.Key.ToParsableString(), status = h.Value.ToString() })
                    .ToArray();

                // Grain types → total activations + per-silo placement (the tree the Diagnostics page renders).
                // Drop Orleans' own system grains (management/reminders/etc.) — only the app's grains matter here.
                var grainTypes = stats
                    .Where(s => !s.GrainType.StartsWith("Orleans.", StringComparison.Ordinal))
                    .GroupBy(s => s.GrainType)
                    .Select(g => new
                    {
                        type = FriendlyGrainType(g.Key),
                        fullType = g.Key,
                        activations = g.Sum(x => x.ActivationCount),
                        silos = g.GroupBy(x => x.SiloAddress.ToParsableString())
                                 .Select(sg => new { silo = sg.Key, count = sg.Sum(x => x.ActivationCount) })
                                 .OrderBy(x => x.silo)
                                 .ToArray(),
                    })
                    .Where(t => t.activations > 0)
                    .OrderByDescending(t => t.activations).ThenBy(t => t.type)
                    .ToArray();

                return Results.Json(new { ok = true, leader, silos, grains = grainTypes }, ConfigSchema.Json);
            }
            catch (Exception ex)
            {
                return Results.Json(new { ok = false, message = ex.Message }, ConfigSchema.Json);
            }
        });

        // The energy-flow tree computed by the distributed node grains (v3): each node computes its own value
        // and publishes it to the flow grain, which serves the projection here. Reads cost one grain call —
        // nothing walks the tree.
        app.MapGet("/api/flow/tree", async (HttpContext ctx) =>
        {
            try
            {
                var snap = await grains.GetGrain<Grains.Abstractions.Flow.IFlowGrain>(0).Current();
                var nodes = snap.Values
                    .GroupBy(v => v.NodeId)
                    .OrderBy(g => g.Key)
                    .Select(g => new { node = g.Key, metrics = g.Select(v => new { metric = v.Metric.ToString(), value = v.Value }).ToArray() })
                    .ToArray();
                return Results.Json(new { ok = true, version = snap.Version, nodes }, ConfigSchema.Json);
            }
            catch (Exception ex) { return Results.Json(new { ok = false, message = ex.Message }, ConfigSchema.Json); }
        });

        // Restart a tier — or everything. In Kubernetes this is a rollout restart of the matching
        // Deployment(s), which also rolls to the latest image; elsewhere it's a bus request every matching
        // process obeys; "local" just stops this process (the classic behaviour).
        app.MapPost("/api/restart", async (HttpContext ctx) =>
        {
            var target = (ctx.Request.Query["target"].FirstOrDefault() ?? "local").Trim().ToLowerInvariant();

            if (target is "" or "local")
            {
                // #192: the restarter decides how — replacing the pod under Kubernetes, stopping otherwise.
                if (restarter is not null)
                {
                    var message = await restarter.RestartAsync("GUI request");
                    return Results.Json(new { ok = true, message }, ConfigSchema.Json);
                }
                Log.Information("Restart requested via GUI; stopping this process.");
                Core.SelfRestart.Mark("GUI request");
                _ = Task.Run(async () => { await Task.Delay(300); lifetime.StopApplication(); });
                return Results.Json(new { ok = true, message = "Restarting this process…" }, ConfigSchema.Json);
            }

            if (configSource is KubernetesConfigSource kube)
            {
                try
                {
                    var restarted = await RolloutRestartAsync(kube, target, ctx.RequestAborted);
                    return restarted.Count == 0
                        ? Results.Json(new { ok = false, message = $"No deployment matched '{target}'." }, ConfigSchema.Json)
                        : Results.Json(new { ok = true, message = $"Rollout restart: {string.Join(", ", restarted)}." }, ConfigSchema.Json);
                }
                catch (Exception ex) { return Results.Json(new { ok = false, message = $"Rollout restart failed: {ex.Message}" }, ConfigSchema.Json); }
            }

            // Non-Kubernetes: ask the matching process(es) to restart over the bus.
            try
            {
                var cmd = new Core.RestartCommand(target, DateTime.UtcNow);
                await ((HiveMQClient)mqtt).PublishAsync(new MQTT5PublishMessage(Core.RestartCommand.TopicFor(config.MQTT.ParentTopic), QualityOfService.AtLeastOnceDelivery)
                {
                    PayloadAsString = System.Text.Json.JsonSerializer.Serialize(cmd, ConfigSchema.Json),
                    Retain = false,
                });
                return Results.Json(new { ok = true, message = $"Restart requested for '{target}'." }, ConfigSchema.Json);
            }
            catch (Exception ex) { return Results.Json(new { ok = false, message = $"Could not publish restart: {ex.Message}" }, ConfigSchema.Json); }
        });

        // What can be restarted, and how, so the Diagnostics page renders the right buttons.
        app.MapGet("/api/restart/targets", async (HttpContext ctx) =>
        {
            if (configSource is KubernetesConfigSource kube)
            {
                var targets = new List<object> { new { id = "all", label = "Everything" } };
                try
                {
                    // Only the tiers of a split deployment need their own button; an all-in-one Deployment
                    // (no component label) is covered by "Everything".
                    foreach (var d in (await AppDeploymentsAsync(kube, ctx.RequestAborted)).OrderBy(d => d.Metadata?.Name))
                    {
                        var comp = ComponentOf(d);
                        if (!string.IsNullOrEmpty(comp)) targets.Add(new { id = comp, label = $"{comp} ({d.Metadata?.Name})" });
                    }
                }
                catch { /* fall back to just "Everything" */ }
                return Results.Json(new { ok = true, method = "rollout", targets }, ConfigSchema.Json);
            }

            // Non-Kubernetes: offer whole roles seen in the cluster (split deployment), else just this process.
            var procs = await grains.GetGrain<Grains.Abstractions.Diagnostics.IProcessRegistryGrain>(0).Active();
            var roles = procs.SelectMany(p => p.Roles).Distinct(StringComparer.OrdinalIgnoreCase).OrderBy(r => r).ToList();
            if (procs.Count > 1 && roles.Count > 0)
            {
                var targets = new List<object> { new { id = "all", label = "Everything" } };
                targets.AddRange(roles.Select(r => (object)new { id = r, label = r }));
                return Results.Json(new { ok = true, method = "signal", targets }, ConfigSchema.Json);
            }
            return Results.Json(new { ok = true, method = "local", targets = new[] { new { id = "local", label = "This process" } } }, ConfigSchema.Json);
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
                var pdu = ResolveInstance(ctx.Request.Query["instance"]).Pdu;
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

        // Browse what's on the broker, for the Nodes editor's topic autocomplete. Asking is what keeps the
        // index alive: the grain leases itself to readers and the subscription only exists while someone is
        // browsing (see ITopicIndexGrain), so this endpoint both queries and renews.
        // Retained Home Assistant discovery configs this build would no longer publish — and, on POST, the
        // clearing of them.
        //
        // A discovery config is retained, so it outlives whatever it described: an outlet that later gained a
        // native energy sensor, a tier deleted from the hierarchy, a node renamed. Home Assistant goes on
        // showing the device, and the publish loop can never find it again because that loop only ever walks
        // the nodes that exist now. Seen live: fifteen orphans, several of them a second and third copy of an
        // outlet that already had one.
        //
        // Two endpoints on purpose. Deleting devices from someone's Home Assistant is not something to do on
        // a timer or at startup — GET says exactly what would go, POST does it, and the operator decides.
        app.MapGet("/api/ha/orphans", async () =>
        {
            try
            {
                var found = await OrphanedDiscoveryAsync();
                return Results.Json(new { ok = true, prefix = config.HASS.DiscoveryTopic, topics = found }, ConfigSchema.Json);
            }
            catch (Exception ex) { return Results.Json(new { ok = false, message = ex.Message }, ConfigSchema.Json); }
        });

        app.MapPost("/api/ha/orphans/clear", async (HttpContext ctx) =>
        {
            try
            {
                var found = await OrphanedDiscoveryAsync();
                // An empty retained payload is how MQTT deletes a retained message, and how Home Assistant is
                // told the device is gone. Same mechanism the exporter already uses for a single duplicate.
                foreach (var topic in found)
                    await mqtt.PublishAsync(new MQTT5PublishMessage(topic, QualityOfService.AtLeastOnceDelivery)
                    {
                        Payload = Array.Empty<byte>(),
                        Retain = true,
                    });

                if (found.Count > 0)
                    Log.Information($"Cleared {found.Count} orphaned Home Assistant discovery config(s) at the operator's request.");
                return Results.Json(new { ok = true, cleared = found.Count, topics = found }, ConfigSchema.Json);
            }
            catch (Exception ex) { return Results.Json(new { ok = false, message = ex.Message }, ConfigSchema.Json); }
        });

        app.MapGet("/api/mqtt/topics", async (HttpContext ctx) =>
        {
            try
            {
                var index = grains.GetGrain<Grains.Abstractions.Discovery.ITopicIndexGrain>(0);
                // The filter to browse (default '#'); a restricted broker can narrow it, e.g. 'solar_assistant/#'.
                var filter = ctx.Request.Query["filter"].FirstOrDefault();
                var state = await index.Renew(filter);
                var q = ctx.Request.Query["q"].FirstOrDefault();
                var limit = int.TryParse(ctx.Request.Query["limit"].FirstOrDefault(), out var n) ? n : 50;

                var topics = (await index.Search(q, limit)).Select(t =>
                {
                    var hint = Core.Flow.TopicSampleAnalyzer.Analyze(t.Topic, t.Payload);
                    return new
                    {
                        topic = t.Topic,
                        payload = t.Payload,
                        seenUtc = t.SeenUtc,
                        metric = hint.Metric,
                        unit = hint.Unit,
                        value = hint.Value,
                        isJson = hint.IsJson,
                        fields = hint.Fields,
                    };
                }).ToArray();

                // "listening" tells the editor whether anything is feeding the index yet; "granted" tells it
                // whether the broker actually allowed the subscription, so a denied ACL reads as a clear
                // message instead of a mysteriously empty list.
                return Results.Json(new { ok = true, listening = state.Listening, indexed = state.Topics, capacity = state.Capacity, filter = state.Filter, granted = state.Granted, topics }, ConfigSchema.Json);
            }
            catch (Exception ex) { return Results.Json(new { ok = false, message = ex.Message }, ConfigSchema.Json); }
        });

        // One topic's last payload and what it implies — the metric/unit to bind, and for a JSON payload the
        // fields you can pick from. Used when a topic is chosen, to fill the rest of the binding in.
        app.MapGet("/api/mqtt/topic", async (HttpContext ctx) =>
        {
            try
            {
                var topic = ctx.Request.Query["topic"].FirstOrDefault() ?? "";
                var index = grains.GetGrain<Grains.Abstractions.Discovery.ITopicIndexGrain>(0);
                await index.Renew(null);   // keep the current browse filter alive; we only want one topic's detail
                var sample = await index.Get(topic);
                if (sample is null)
                    return Results.Json(new { ok = false, message = "Nothing has been seen on that topic yet." }, ConfigSchema.Json);

                var hint = Core.Flow.TopicSampleAnalyzer.Analyze(sample.Topic, sample.Payload);
                var fields = hint.Fields.Select(f => new { field = f, metric = Core.Flow.TopicSampleAnalyzer.MetricForField(sample.Topic, f) }).ToArray();
                return Results.Json(new
                {
                    ok = true,
                    topic = sample.Topic,
                    payload = sample.Payload,
                    seenUtc = sample.SeenUtc,
                    metric = hint.Metric,
                    unit = hint.Unit,
                    value = hint.Value,
                    isJson = hint.IsJson,
                    fields,
                }, ConfigSchema.Json);
            }
            catch (Exception ex) { return Results.Json(new { ok = false, message = ex.Message }, ConfigSchema.Json); }
        });

        // Read a block of registers off a Modbus device — the explorer behind "Browse registers". One
        // deliberate read per click (a gateway usually allows a single client, and the worker is already
        // polling it), decoded every way that makes sense so you can see which one looks right.
        app.MapPost("/api/modbus/scan", async (HttpContext ctx) =>
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ctx.RequestAborted);
            cts.CancelAfter(TimeSpan.FromSeconds(20));
            try
            {
                var req = await System.Text.Json.JsonSerializer.DeserializeAsync<ModbusScanRequest>(ctx.Request.Body, ProbeJson, cts.Token);
                if (req is null || string.IsNullOrWhiteSpace(req.Host))
                    return Results.Json(new { ok = false, message = "A host is required." }, ConfigSchema.Json);

                var start = Math.Max(0, req.Start);
                var count = Math.Clamp(req.Count <= 0 ? 32 : req.Count, 1, 125);   // Modbus caps a read at 125 registers
                var bank = string.IsNullOrWhiteSpace(req.RegisterType) ? "holding" : req.RegisterType!;

                // Each register is read as uint16 and int16, and each pair additionally as float32/int32, so
                // the answer to "which decoding is this device using?" is visible rather than guessed.
                var items = new List<EnergyFlowSource>();
                for (var i = 0; i < count; i++)
                {
                    items.Add(new EnergyFlowSource { Type = "modbus", Register = start + i, RegisterType = bank, DataType = "uint16" });
                    items.Add(new EnergyFlowSource { Type = "modbus", Register = start + i, RegisterType = bank, DataType = "int16" });
                    items.Add(new EnergyFlowSource { Type = "modbus", Register = start + i, RegisterType = bank, DataType = "uint32" });
                    items.Add(new EnergyFlowSource { Type = "modbus", Register = start + i, RegisterType = bank, DataType = "float32" });
                }

                var (ok, message, readings) = await Task.Run(() => EnergyFlowModbusSourceService.Probe(
                    req.Host, req.Port <= 0 ? 502 : req.Port, req.UnitId <= 0 ? 1 : req.UnitId, req.Framing, req.TimeoutMs, items), cts.Token);

                // Fold the four decodings of each register back into one row.
                var rows = new List<object>();
                for (var i = 0; i < count; i++)
                {
                    var at = i * 4;
                    rows.Add(new
                    {
                        register = start + i,
                        uint16 = at < readings.Count ? readings[at].Value : null,
                        int16 = at + 1 < readings.Count ? readings[at + 1].Value : null,
                        uint32 = at + 2 < readings.Count ? readings[at + 2].Value : null,
                        float32 = at + 3 < readings.Count ? readings[at + 3].Value : null,
                        error = at < readings.Count ? readings[at].Error : "not read",
                    });
                }

                return Results.Json(new { ok, message, registerType = bank, rows }, ConfigSchema.Json);
            }
            catch (OperationCanceledException) { return Results.Json(new { ok = false, message = "Modbus scan timed out." }, ConfigSchema.Json); }
            catch (Exception ex) { return Results.Json(new { ok = false, message = ex.Message }, ConfigSchema.Json); }
        });

        // Probe a Modbus TCP device: connect, and optionally read a set of register specs, returning the
        // decoded values. Powers the "Test connection" button and the live per-binding value display in the
        // Flow editor. Read-only; uses a throwaway connection so it works before the config is saved.
        app.MapPost("/api/modbus/probe", async (HttpContext ctx) =>
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ctx.RequestAborted);
            cts.CancelAfter(TimeSpan.FromSeconds(15));
            try
            {
                var req = await System.Text.Json.JsonSerializer.DeserializeAsync<ModbusProbeRequest>(
                    ctx.Request.Body, ProbeJson, cts.Token);
                if (req is null || string.IsNullOrWhiteSpace(req.Host))
                    return Results.Json(new { ok = false, message = "A host is required." }, ConfigSchema.Json);

                var (ok, message, readings) = await Task.Run(() => EnergyFlowModbusSourceService.Probe(
                    req.Host, req.Port <= 0 ? 502 : req.Port, req.UnitId <= 0 ? 1 : req.UnitId, req.Framing, req.TimeoutMs, req.Items), cts.Token);
                return Results.Json(new { ok, message, readings }, ConfigSchema.Json);
            }
            catch (OperationCanceledException) { return Results.Json(new { ok = false, message = "Modbus probe timed out." }, ConfigSchema.Json); }
            catch (Exception ex) { return Results.Json(new { ok = false, message = ex.Message }, ConfigSchema.Json); }
        });

        // Current live value per (node, metric) as the running ingests hold it — reads the shared
        // IFlowValueSource (MQTT + Modbus + any future source), so the Nodes editor can show a "Current"
        // value for every binding type uniformly. Returns null for anything not currently reported/fresh.
        app.MapPost("/api/flow/live", async (HttpContext ctx) =>
        {
            try
            {
                var reqs = await System.Text.Json.JsonSerializer.DeserializeAsync<List<LiveValueQuery>>(
                    ctx.Request.Body, ProbeJson, ctx.RequestAborted) ?? new();
                // `value` keeps its meaning exactly: the reading only if it can still be believed. The extra
                // fields describe a reading that has expired, which TryGetValue deliberately hides — without
                // them a publisher that died an hour ago is indistinguishable from one never configured, and
                // the two need completely different fixes.
                var diag = live as Core.Flow.IFlowValueDiagnostics;
                var values = reqs.Select(q =>
                {
                    var node = q.Node ?? ""; var metric = q.Metric ?? "";
                    double? v = live is not null && live.TryGetValue(node, metric, out var got) ? got : null;
                    if (diag is null || !diag.TryDescribe(node, metric, out var r))
                        return new { node = q.Node, metric = q.Metric, value = v, reported = (double?)null, atUtc = (DateTime?)null, ageSeconds = (double?)null, fresh = (bool?)null, staleAfterSeconds = (int?)null };
                    return new
                    {
                        node = q.Node,
                        metric = q.Metric,
                        value = v,
                        reported = (double?)r.Value,
                        atUtc = (DateTime?)r.AtUtc,
                        ageSeconds = (double?)Math.Round((DateTime.UtcNow - r.AtUtc).TotalSeconds, 1),
                        fresh = (bool?)r.Fresh,
                        staleAfterSeconds = (int?)r.StaleAfterSeconds,
                    };
                });
                return Results.Json(new { ok = true, values }, ConfigSchema.Json);
            }
            catch (Exception ex) { return Results.Json(new { ok = false, message = ex.Message }, ConfigSchema.Json); }
        });

        // Validate the EmonCMS configuration (HTTP: reach the server + check the API key; MQTT: broker up).
        app.MapPost("/api/test/emoncms", async (HttpContext ctx) =>
        {
            var e = config.EmonCMS;
            if (!e.Enabled)
                return Results.Json(new { ok = false, message = "EmonCMS is disabled (EmonCMS.Enabled is false)." }, ConfigSchema.Json);

            if (e.Transport == EmonCmsTransport.Mqtt)
            {
                var topic = $"{(e.MqttBaseTopic ?? "emon").TrimEnd('/')}/{e.Node}";
                return mqtt.IsConnected()
                    ? Results.Json(new { ok = true, message = $"MQTT broker connected; publishing to '{topic}'. (EmonCMS receipt can't be confirmed from here.)" }, ConfigSchema.Json)
                    : Results.Json(new { ok = false, message = "MQTT broker is not connected — check the MQTT settings." }, ConfigSchema.Json);
            }

            if (string.IsNullOrWhiteSpace(e.Url))
                return Results.Json(new { ok = false, message = "EmonCMS.Url is required for the HTTP transport." }, ConfigSchema.Json);

            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ctx.RequestAborted);
            cts.CancelAfter(TimeSpan.FromSeconds(15));
            try
            {
                var url = $"{e.Url.TrimEnd('/')}/feed/list.json?apikey={Uri.EscapeDataString(e.ApiKey ?? string.Empty)}";
                using var resp = await testHttp.GetAsync(url, cts.Token);
                var body = (await resp.Content.ReadAsStringAsync(cts.Token)).TrimStart();
                if (!resp.IsSuccessStatusCode)
                    return Results.Json(new { ok = false, message = $"EmonCMS returned HTTP {(int)resp.StatusCode}." }, ConfigSchema.Json);
                if (body.StartsWith("["))
                    return Results.Json(new { ok = true, message = "Reached EmonCMS and the API key was accepted." }, ConfigSchema.Json);
                if (body.Contains("\"success\":false", StringComparison.OrdinalIgnoreCase) || body.Equals("false", StringComparison.OrdinalIgnoreCase) || body.Contains("invalid", StringComparison.OrdinalIgnoreCase))
                    return Results.Json(new { ok = false, message = "Reached EmonCMS but the API key was rejected (a read/write key is required)." }, ConfigSchema.Json);
                return Results.Json(new { ok = true, message = "Reached EmonCMS." }, ConfigSchema.Json);
            }
            catch (Exception ex)
            {
                return Results.Json(new { ok = false, message = $"Could not reach EmonCMS: {ex.Message}" }, ConfigSchema.Json);
            }
        });

        // HA Energy Mapping (#128): push the current hierarchy into HA's Energy Dashboard now, or clear it.
        // Both take the connection settings in the body so they work with the page's (possibly unsaved) edits.
        app.MapPost("/api/ha-energy/sync", async (HttpContext ctx) =>
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ctx.RequestAborted);
            cts.CancelAfter(TimeSpan.FromSeconds(20));
            try
            {
                var b = await System.Text.Json.JsonDocument.ParseAsync(ctx.Request.Body, cancellationToken: cts.Token);
                var url = b.RootElement.TryGetProperty("url", out var u) ? u.GetString() : config.HASS.EnergyDashboard.Url;
                var token = b.RootElement.TryGetProperty("token", out var t) ? t.GetString() : config.HASS.EnergyDashboard.Token;
                var count = await haEnergy.SyncAsync(url ?? "", token ?? "", cts.Token);
                return Results.Json(new { ok = true, message = count == 0 ? "No tiers had an energy sensor in HA yet — enable “Export tiers to MQTT” + HA discovery and wait a poll." : $"Synced {count} device(s) into the Energy Dashboard." }, ConfigSchema.Json);
            }
            catch (Exception ex)
            {
                return Results.Json(new { ok = false, message = $"Sync failed: {ex.Message}" }, ConfigSchema.Json);
            }
        });

        app.MapPost("/api/ha-energy/clear", async (HttpContext ctx) =>
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ctx.RequestAborted);
            cts.CancelAfter(TimeSpan.FromSeconds(20));
            try
            {
                var b = await System.Text.Json.JsonDocument.ParseAsync(ctx.Request.Body, cancellationToken: cts.Token);
                var url = b.RootElement.TryGetProperty("url", out var u) ? u.GetString() : config.HASS.EnergyDashboard.Url;
                var token = b.RootElement.TryGetProperty("token", out var t) ? t.GetString() : config.HASS.EnergyDashboard.Token;
                var count = await haEnergy.ClearAsync(url ?? "", token ?? "", cts.Token);
                return Results.Json(new { ok = true, message = $"Cleared {count} device(s) from the Energy Dashboard." }, ConfigSchema.Json);
            }
            catch (Exception ex)
            {
                return Results.Json(new { ok = false, message = $"Clear failed: {ex.Message}" }, ConfigSchema.Json);
            }
        });

        // Manually run EmonCMS feed provisioning now (#163) and report what it did — so you can see it work
        // (or why it's a no-op) without waiting for the periodic pass. v3: through the same single-activation
        // grain the periodic pass uses, so a click can't race it into duplicate feeds.
        app.MapPost("/api/emoncms/provision-feeds", async () =>
        {
            try
            {
                var r = await grains.GetGrain<Grains.Abstractions.EmonCms.IEmonCmsFeedGrain>(0).Reconcile(force: true);
                return Results.Json(new { ok = r.Ok, message = r.Message, feeds = r.FeedsCreated, processes = r.ProcessesSet, virtualFeeds = r.VirtualFeeds }, ConfigSchema.Json);
            }
            catch (Exception ex)
            {
                return Results.Json(new { ok = false, message = $"Feed provisioning failed: {ex.Message}" }, ConfigSchema.Json);
            }
        });

        // Delete every EmonCMS feed rPDU2MQTT created (under its tag/node) — the "clean up" button.
        app.MapPost("/api/emoncms/delete-feeds", async () =>
        {
            try
            {
                var r = await grains.GetGrain<Grains.Abstractions.EmonCms.IEmonCmsFeedGrain>(0).DeleteAll();
                return Results.Json(new { ok = r.Ok, message = r.Message }, ConfigSchema.Json);
            }
            catch (Exception ex)
            {
                return Results.Json(new { ok = false, message = $"Delete feeds failed: {ex.Message}" }, ConfigSchema.Json);
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
                var (id, pdu, _) = ResolveInstance(ctx.Request.Query["instance"]);
                var data = await ResolveData(id, pdu, cts.Token);

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
            return Results.Json(await BuildLiveDataAsync(ctx.Request.Query["instance"], ctx.RequestAborted), ConfigSchema.Json);
        });

        // Generated integration paths per measurement (MQTT topic, Prometheus metric, EmonCMS key),
        // reflecting the current overrides — for the GUI "Paths" view.
        app.MapGet("/api/paths", async (HttpContext ctx) =>
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ctx.RequestAborted);
            cts.CancelAfter(TimeSpan.FromSeconds(20));
            try
            {
                var (id, pdu, _) = ResolveInstance(ctx.Request.Query["instance"]);
                var data = await ResolveData(id, pdu, cts.Token);
                return Results.Json(BuildPaths(data, config), ConfigSchema.Json);
            }
            catch (Exception ex)
            {
                return Results.Json(new { ok = false, message = $"Could not read live PDU data: {ex.Message}" }, ConfigSchema.Json);
            }
        });

        // Power/energy flow graph (PDU -> outlets) for the Sankey "Flow" tab.
        app.MapGet("/api/flow", async (HttpContext ctx) =>
        {
            return Results.Json(await BuildFlowAsync(ctx.Request.Query["instance"], ctx.Request.Query["metric"].ToString(), ctx.RequestAborted), ConfigSchema.Json);
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
                var data = await pduFactory.Create(parsed.Primary, parsed).GetRootData_Public(cts.Token);
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
                var (id, pdu, instanceCfg) = ResolveInstance(ctx.Request.Query["instance"]);
                var data = await ResolveData(id, pdu, cts.Token);
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
                // Member-outlet lookup (deviceId, index) so each group can show per-member state.
                var outletByKey = data.Devices
                    .SelectMany(d => d.Outlets.Select(o => (dev: d, outlet: o)))
                    .ToDictionary(x => (x.dev.Key, x.outlet.Key));
                var groups = data.Groups.Select(g => new
                {
                    key = g.Key,
                    name = g.Entity_DisplayName,
                    label = pdu.ResolveGroupConfig(g.Key, "label", g.Label ?? ""),
                    members = g.MemberOutlets.Select(m =>
                    {
                        outletByKey.TryGetValue((m.DeviceId, m.OutletIndex), out var hit);
                        return new
                        {
                            number = m.OutletIndex + 1,
                            name = hit.outlet?.Entity_DisplayName ?? $"#{m.OutletIndex + 1}",
                            state = hit.outlet is null ? "unknown" : pdu.ResolveOutletState(m.DeviceId, m.OutletIndex, hit.outlet.State),
                        };
                    }).ToList(),
                }).ToList();
                // PDUs and their circuits (breaker entities), with editable labels — resolved through the
                // pending-write latch like outlets so a just-set value shows immediately.
                var devices = data.Devices.Select(d => new
                {
                    deviceId = d.Key,
                    name = d.Entity_DisplayName,
                    label = pdu.ResolveDeviceConfig(d.Key, "label", d.Label ?? ""),
                    circuits = d.Entity
                        .Where(e => e.Key.StartsWith("breaker", StringComparison.OrdinalIgnoreCase))
                        .OrderBy(e => e.Key)
                        .Select(e => new
                        {
                            key = e.Key,
                            name = e.Entity_DisplayName ?? e.Name,
                            label = pdu.ResolveEntityConfig(d.Key, e.Key, "label", e.Label ?? ""),
                        }).ToList(),
                }).ToList();
                return Results.Json(new { ok = true, actionsEnabled = instanceCfg.ActionsEnabled, outlets, groups, devices }, ConfigSchema.Json);
            }
            catch (Exception ex)
            {
                return Results.Json(new { ok = false, message = $"Could not read live PDU data: {ex.Message}" }, ConfigSchema.Json);
            }
        });

        // Apply a control action to every outlet in a OneView group (fan-out). Gated by ActionsEnabled.
        app.MapPost("/api/control/group", async (HttpContext ctx) =>
        {
            GroupControlRequest? req;
            try { req = await ctx.Request.ReadFromJsonAsync<GroupControlRequest>(ctx.RequestAborted); }
            catch { req = null; }
            if (req is null || string.IsNullOrWhiteSpace(req.GroupKey))
                return Results.BadRequest(new { ok = false, message = "groupKey and action are required." });

            var (_, pdu, instanceCfg) = ResolveInstance(req.Instance);
            if (!instanceCfg.ActionsEnabled)
                return Results.Json(new { ok = false, message = "Write actions are disabled for this PDU instance (ActionsEnabled is false)." }, statusCode: 409);

            var action = (req.Action ?? string.Empty).Trim().ToLowerInvariant();
            if (action is not ("on" or "off" or "reboot"))
                return Results.BadRequest(new { ok = false, message = "action must be on, off or reboot." });

            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ctx.RequestAborted);
            cts.CancelAfter(TimeSpan.FromSeconds(60));
            try
            {
                var n = await pdu.ControlGroupAsync(req.GroupKey, action, cts.Token);
                return Results.Json(new { ok = true, message = $"Group {req.GroupKey} → {action} ({n} outlet(s))." }, ConfigSchema.Json);
            }
            catch (Exception ex)
            {
                return Results.Json(new { ok = false, message = $"Group control failed: {ex.Message}" }, ConfigSchema.Json);
            }
        });

        // Issue an outlet control action (on/off/reboot). Gated by PDU.ActionsEnabled.
        app.MapPost("/api/control/outlet", async (HttpContext ctx) =>
        {
            ControlRequest? req;
            try { req = await ctx.Request.ReadFromJsonAsync<ControlRequest>(ctx.RequestAborted); }
            catch { req = null; }
            if (req is null || string.IsNullOrWhiteSpace(req.DeviceId))
                return Results.BadRequest(new { ok = false, message = "deviceId, index and action are required." });

            var (_, pdu, instanceCfg) = ResolveInstance(req.Instance);
            if (!instanceCfg.ActionsEnabled)
                return Results.Json(new { ok = false, message = "Write actions are disabled for this PDU instance (ActionsEnabled is false)." }, statusCode: 409);

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
            LabelRequest? req;
            try { req = await ctx.Request.ReadFromJsonAsync<LabelRequest>(ctx.RequestAborted); }
            catch { req = null; }
            if (req is null)
                return Results.BadRequest(new { ok = false, message = "A label request body is required." });

            var (_, pdu, instanceCfg) = ResolveInstance(req.Instance);
            if (!instanceCfg.ActionsEnabled)
                return Results.Json(new { ok = false, message = "Write actions are disabled for this PDU instance (ActionsEnabled is false)." }, statusCode: 409);

            var target = (req.Target ?? "outlet").Trim().ToLowerInvariant();
            // Group labels target the OneView master, not a specific device; everything else needs a deviceId.
            if (target != "group" && string.IsNullOrWhiteSpace(req.DeviceId))
                return Results.BadRequest(new { ok = false, message = "deviceId is required." });

            var label = new Dictionary<string, object> { ["label"] = (req.Label ?? string.Empty).Trim() };

            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ctx.RequestAborted);
            cts.CancelAfter(TimeSpan.FromSeconds(20));
            try
            {
                switch (target)
                {
                    case "device":
                        await pdu.SetDeviceConfigAsync(req.DeviceId, label, cts.Token);
                        return Results.Json(new { ok = true, message = "PDU label set." }, ConfigSchema.Json);
                    case "entity":
                        if (string.IsNullOrWhiteSpace(req.EntityKey))
                            return Results.BadRequest(new { ok = false, message = "entityKey is required for an entity label." });
                        await pdu.SetEntityConfigAsync(req.DeviceId, req.EntityKey, label, cts.Token);
                        return Results.Json(new { ok = true, message = "Circuit label set." }, ConfigSchema.Json);
                    case "group":
                        if (string.IsNullOrWhiteSpace(req.GroupKey))
                            return Results.BadRequest(new { ok = false, message = "groupKey is required for a group label." });
                        await pdu.SetGroupConfigAsync(req.GroupKey, label, cts.Token);
                        return Results.Json(new { ok = true, message = "Group label set." }, ConfigSchema.Json);
                    default:
                        await pdu.SetOutletConfigAsync(req.DeviceId, req.Index, label, cts.Token);
                        return Results.Json(new { ok = true, message = $"Outlet {req.Index + 1} label set." }, ConfigSchema.Json);
                }
            }
            catch (Exception ex)
            {
                return Results.Json(new { ok = false, message = $"Set label failed: {ex.Message}" }, ConfigSchema.Json);
            }
        });

        // Render the current form state as YAML (for copy/paste into a ConfigMap, source control, etc.).
        // Import a pasted config.yaml / RpduConfig — merged into what's on screen, or replacing it whole
        // (#214). Nothing is saved: the result comes back for the form to load, so it's reviewed (and the
        // Save button pressed) like any other edit.
        app.MapPost("/api/config/import", async (HttpContext ctx) =>
        {
            try
            {
                var req = await System.Text.Json.JsonSerializer.DeserializeAsync<ConfigImportRequest>(
                    ctx.Request.Body, ProbeJson, ctx.RequestAborted);
                if (req is null)
                    return Results.Json(new { ok = false, message = "Nothing to import." }, ConfigSchema.Json);

                var mode = string.Equals(req.Mode, "replace", StringComparison.OrdinalIgnoreCase)
                    ? Core.ConfigImportMode.Replace
                    : Core.ConfigImportMode.Merge;

                // Merge against what the form currently holds (which may be unsaved), not against the file.
                var current = string.IsNullOrWhiteSpace(req.Current) ? config : ConfigSchema.FromJson(req.Current!);
                var result = Core.ConfigImport.Apply(current, req.Yaml ?? "", mode);

                return Results.Text(
                    "{\"ok\":true,\"sections\":" + System.Text.Json.JsonSerializer.Serialize(result.Sections)
                    + ",\"notes\":" + System.Text.Json.JsonSerializer.Serialize(result.Notes)
                    + ",\"config\":" + ConfigSchema.ToJson(result.Config) + "}",
                    "application/json");
            }
            catch (ArgumentException ex) { return Results.Json(new { ok = false, message = ex.Message }, ConfigSchema.Json); }
            catch (Exception ex) { return Results.Json(new { ok = false, message = $"Import failed: {ex.Message}" }, ConfigSchema.Json); }
        });

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
            // The live flag, not whether a service happens to be registered — discovery services are now
            // always registered and self-gate, so HasSubscribers is always true and says nothing.
            if (!config.HASS.DiscoveryEnabled)
                return Results.Json(new { ok = false, message = "Home Assistant discovery is turned off. Turn it on and save; no restart needed." }, ConfigSchema.Json);

            await discovery.RequestRediscoverAsync(CancellationToken.None);
            return Results.Json(new { ok = true, message = "Discovery republish requested." }, ConfigSchema.Json);
        });

        app.MapPost("/api/discovery/clear", async () =>
        {
            // Deliberately NOT gated on DiscoveryEnabled. Turning discovery off and then clearing what it
            // left behind is the obvious sequence, and refusing there — as this used to — leaves the retained
            // messages on the broker with no way to remove them short of turning discovery back on first.
            // Retracting retained messages needs a broker connection, not a running discovery service.

            // First the services' own clear: each forgets and retracts what it published this run.
            await discovery.RequestClearAsync(CancellationToken.None);

            // Then everything else of ours still retained on the broker. The services only know what THEY
            // published since starting, which is why this button used to leave devices behind — anything
            // from an earlier version, from a config that has since changed, or from the energy-flow
            // exporter's separate bookkeeping, survived every "clear" and stayed in Home Assistant forever.
            // "Clear discovery" has to mean the broker is clean, so the list comes from the broker.
            var swept = 0;
            var message = "Cleared the retained Home Assistant discovery messages.";
            try
            {
                var prefix = config.HASS.DiscoveryTopic;
                var root = (prefix ?? "").Trim().Trim('/');
                var index = grains.GetGrain<Grains.Abstractions.Discovery.ITopicIndexGrain>(0);

                // The index only fills while someone is reading it, and the subscription it needs is opened by
                // another process on its own timer. Reading it the instant after asking would sweep whatever
                // happened to be cached — possibly for a different filter, possibly nothing — and then report
                // success. Wait for the feed to actually be live, and give the retained backlog a moment to
                // land, before deciding what exists.
                var state = await index.Renew(root + "/#");
                for (var i = 0; i < 30 && !(state.Listening && state.Granted != false); i++)
                {
                    await Task.Delay(500);
                    state = await index.Renew(root + "/#");
                }
                if (state.Granted == false)
                    throw new InvalidOperationException($"the broker refused a subscription to '{root}/#', so what is retained there cannot be read");
                if (!state.Listening)
                    throw new InvalidOperationException("no process is feeding the topic index, so what is retained on the broker cannot be read");
                await Task.Delay(2000);   // retained messages arrive in a burst; let it finish

                // Uncapped on purpose: Search caps at 200 and orders by topic length, which is right for an
                // autocomplete and wrong for a sweep that must not miss one.
                var retained = await index.TopicsUnder(root + "/");

                foreach (var topic in Core.HomeAssistant.HaDiscoveryTopics.Owned(retained, prefix))
                {
                    await mqtt.PublishAsync(new MQTT5PublishMessage(topic, QualityOfService.AtLeastOnceDelivery)
                    {
                        Payload = Array.Empty<byte>(),
                        Retain = true,
                    });
                    swept++;
                }
                Log.Information($"Clear discovery: swept {swept} retained discovery topic(s) from the broker "
                              + $"(index held {retained.Count} under '{root}/').");
                message = swept > 0
                    ? $"Cleared every rPDU2MQTT discovery message on the broker — {swept} topic(s), including any left over from earlier versions."
                    : "Cleared this run's discovery messages; the broker held nothing else of ours.";
            }
            catch (Exception ex)
            {
                // The services' own clear already succeeded; say what did and did not happen rather than
                // reporting a blanket failure.
                Log.Warning($"Clear discovery: the broker sweep failed ({ex.Message}); only this run's topics were cleared.");
                message = "Cleared this run's discovery messages, but could not sweep the broker for older ones: " + ex.Message;
            }

            return Results.Json(new { ok = true, swept, message }, ConfigSchema.Json);
        });
    }

    /// <summary>Body of a POST /api/control/outlet request.</summary>
    private sealed record ControlRequest(string DeviceId, int Index, string Action, string? Instance = null);

    /// <summary>Body of a POST /api/control/label request.</summary>
    private sealed record LabelRequest(string DeviceId, string? Target, int Index, string? EntityKey, string? GroupKey, string Label, string? Instance = null);

    /// <summary>Body of a POST /api/control/group request.</summary>
    private sealed record GroupControlRequest(string GroupKey, string Action, string? Instance = null);

    /// <summary>One pivoted live-view row: an outlet/entity with its numeric measurements + state.</summary>
    private static object BuildLiveEntity(string device, string source, string kind, int? number, string? state, IEnumerable<Models.PDU.Measurement> measurements)
    {
        var values = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);
        foreach (var m in measurements)
            if (!string.IsNullOrEmpty(m.Type) && double.TryParse(m.Value, System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out var v))
                values[m.Type] = v;
        return new { device, source, kind, number, state, values };
    }

    /// <summary>Parse a PDU measurement string to a number (null if missing/unparseable).</summary>
    private static double? ParseMeasure(string? s)
        => double.TryParse(s, System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out var v) ? v : null;

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

    private static string Version => rPDU2MQTT.Helpers.AppInfo.Version;

    /// <summary>
    /// Short, readable grain name from Orleans' grain-type string. That string is the assembly-qualified CLR
    /// name (e.g. "rPDU2MQTT.Grains.Modbus.ModbusGrain, rPDU2MQTT.Grains"), so strip the ", Assembly" tail and
    /// any generic/nested markers first, then take the class name and drop the "Grain" suffix.
    /// </summary>
    private static string FriendlyGrainType(string grainType)
    {
        if (string.IsNullOrWhiteSpace(grainType)) return grainType;
        var s = grainType;
        var comma = s.IndexOf(',');   if (comma >= 0) s = s[..comma];        // drop ", AssemblyName"
        var bracket = s.IndexOf('[');  if (bracket >= 0) s = s[..bracket];    // drop generic args
        var last = s.Split('.', '+', '/').Last().Trim();                       // class name (+ = nested type)
        if (last.EndsWith("grain", StringComparison.OrdinalIgnoreCase))
            last = last[..^"grain".Length];                                    // "ModbusGrain" -> "Modbus"
        return last.Length == 0 ? grainType : char.ToUpperInvariant(last[0]) + last[1..];
    }

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

    /// <summary>
    /// Read the operator's update report from the CR <c>.status.update</c> (#210), or null if none. Bounded
    /// by a short timeout so a slow/unreachable API server can never hang the header's /api/status call.
    /// </summary>
    private async Task<object?> ReadOperatorUpdateAsync(KubernetesConfigSource? k8s, CancellationToken ct)
    {
        if (k8s is null) return null;   // operator only runs with the Kubernetes config source
        try { return await grains.GetGrain<Grains.Abstractions.Operator.IOperatorGrain>(0).Status(); }
        catch (Exception ex) { Log.Debug($"Could not read operator status from grain: {ex.Message}"); return null; }
    }

    // --- Kubernetes rollout restart ------------------------------------------------------------

    /// <summary>Deployment's component (tier) label, or "" — Metadata.Labels is IDictionary (no GetValueOrDefault).</summary>
    private static string ComponentOf(V1Deployment d)
        => d.Metadata?.Labels is { } l && l.TryGetValue("app.kubernetes.io/component", out var c) ? c : "";

    /// <summary>This app's Deployments, found via the running pod's own labels so we only touch our own.</summary>
    private async Task<IList<V1Deployment>> AppDeploymentsAsync(KubernetesConfigSource kube, CancellationToken ct)
    {
        var list = await kube.Client.AppsV1.ListNamespacedDeploymentAsync(kube.Namespace, labelSelector: await AppSelectorAsync(kube, ct), cancellationToken: ct);
        return list.Items;
    }

    /// <summary>Label selector scoping to this release — read off this pod, else a sensible default.</summary>
    private static async Task<string> AppSelectorAsync(KubernetesConfigSource kube, CancellationToken ct)
    {
        var podName = Environment.GetEnvironmentVariable("RPDU2MQTT_POD_NAME");
        if (!string.IsNullOrEmpty(podName))
        {
            try
            {
                var labels = (await kube.Client.CoreV1.ReadNamespacedPodAsync(podName, kube.Namespace, cancellationToken: ct)).Metadata?.Labels;
                if (labels is not null)
                {
                    if (labels.TryGetValue("app.kubernetes.io/instance", out var inst) && !string.IsNullOrEmpty(inst)) return $"app.kubernetes.io/instance={inst}";
                    if (labels.TryGetValue("app.kubernetes.io/name", out var nm) && !string.IsNullOrEmpty(nm)) return $"app.kubernetes.io/name={nm}";
                }
            }
            catch { /* fall through to the default */ }
        }
        return "app.kubernetes.io/name=rpdu2mqtt";
    }

    /// <summary>
    /// Roll restart the Deployment(s) matching <paramref name="target"/> ("all" or a component/role) by
    /// stamping the pod template's <c>restartedAt</c> annotation — exactly what <c>kubectl rollout restart</c>
    /// does, so pods cycle gracefully and re-pull the image. Returns the names actually patched.
    /// </summary>
    private async Task<List<string>> RolloutRestartAsync(KubernetesConfigSource kube, string target, CancellationToken ct)
    {
        var restarted = new List<string>();
        var annotations = new Dictionary<string, string> { ["kubectl.kubernetes.io/restartedAt"] = DateTime.UtcNow.ToString("o") };
        var body = new V1Patch(
            System.Text.Json.JsonSerializer.Serialize(new { spec = new { template = new { metadata = new { annotations } } } }),
            V1Patch.PatchType.MergePatch);
        foreach (var d in await AppDeploymentsAsync(kube, ct))
        {
            var comp = ComponentOf(d);
            if (d.Metadata?.Name is null) continue;
            if (!string.Equals(target, "all", StringComparison.OrdinalIgnoreCase) && !string.Equals(comp, target, StringComparison.OrdinalIgnoreCase)) continue;
            await kube.Client.AppsV1.PatchNamespacedDeploymentAsync(body, d.Metadata.Name, kube.Namespace, cancellationToken: ct);
            restarted.Add(d.Metadata.Name);
        }
        return restarted;
    }

    // Case-insensitive so the GUI can post {host,...} or {Host,...}; Items map onto EnergyFlowSource's fields.
    private static readonly System.Text.Json.JsonSerializerOptions ProbeJson = new() { PropertyNameCaseInsensitive = true };

    /// <summary>Body of POST /api/modbus/probe: a device to reach + the register specs to read.</summary>
    private sealed record ModbusProbeRequest(string Host, int Port, int UnitId, string? Framing, int TimeoutMs, List<EnergyFlowSource>? Items);

    /// <summary>Body of POST /api/config/import: the pasted YAML, how to apply it, and the form's current state.</summary>
    private sealed record ConfigImportRequest(string? Yaml, string? Mode, string? Current);

    /// <summary>Body of POST /api/modbus/scan: a device to reach + the block of registers to browse.</summary>
    private sealed record ModbusScanRequest(string Host, int Port, int UnitId, string? Framing, int TimeoutMs, int Start, int Count, string? RegisterType);

    /// <summary>One (node, metric) whose current live value the Nodes editor wants.</summary>
    private sealed record LiveValueQuery(string? Node, string? Metric);
}
