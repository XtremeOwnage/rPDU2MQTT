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
    // Config sections contributed by externally loaded plugins, so the GUI renders a page for each.
    private readonly PluginSchemaSections? pluginSections;
    // Every integration this build carries, built-in or loaded from plugins/.
    private readonly Core.Integrations.IntegrationRegistry? integrations;
    // The write seam. Routes to the PDU that reported the device, or to the plugin that owns it.
    private readonly Abstractions.Pdu.IOutletControl? outletControl;
    // Anything that can offer nodes to adopt — the broker index today, a plugin tomorrow.
    private readonly IReadOnlyList<Core.Integrations.INodeProvider> nodeProviders;
    // The Status board, held in this process.
    private readonly Core.Status.StatusBoard? statusBoard;
    private readonly Core.Diagnostics.ProcessRegistry? processes;
    private readonly Core.Discovery.TopicIndex topicIndex;
    private readonly Core.Flow.IMeasurementHistory? history;
    // What the last save could not apply to this process. Reported on the status card and in the header.
    private readonly Core.RestartPending pending;
    private static readonly HttpClient testHttp = new() { Timeout = TimeSpan.FromSeconds(15) };
    private WebApplication? app;
    // Created on the first /api/events connection; the pump only runs while a tab is watching.
    private GuiEventHub? events;
    private readonly object eventsGate = new();

    // The deployment operator, when this build runs somewhere it can roll itself (Kubernetes).
    private readonly Core.Operator.IOperatorControl? deployOperator;
    // What each Modbus device last did, for the diagnostics page.
    private readonly Core.Modbus.ModbusDevices? modbusDevices;

    public GuiService(Config config, IHiveMQClient mqtt, PDU pdu, DiscoveryCoordinator discovery, IConfigSource configSource, IHostApplicationLifetime lifetime, HealthState health, PduInstanceFactory pduFactory, PduInstanceRegistry registry, InstanceManager instances, EmonCmsStatus emonCmsStatus, Core.ISnapshotCache snapshots, Core.HostRole hostRoles, HaEnergyDashboardSync haEnergy, Core.Flow.IFlowValueSource? live = null, Core.IProcessRestarter? restarter = null, Core.Flow.IMeasurementHistory? history = null, Core.RestartPending? pending = null, PluginSchemaSections? pluginSections = null, Core.Integrations.IntegrationRegistry? integrations = null, Abstractions.Pdu.IOutletControl? outletControl = null, IEnumerable<Core.Integrations.INodeProvider>? nodeProviders = null, Core.Status.StatusBoard? statusBoard = null, Core.Diagnostics.ProcessRegistry? processes = null, Core.Discovery.TopicIndex? topicIndex = null, Core.Operator.IOperatorControl? deployOperator = null, Core.Modbus.ModbusDevices? modbusDevices = null)
    {
        this.live = live;
        this.pluginSections = pluginSections;
        this.integrations = integrations;
        this.outletControl = outletControl;
        this.nodeProviders = nodeProviders?.ToList() ?? [];
        this.statusBoard = statusBoard;
        this.processes = processes;
        this.topicIndex = topicIndex ?? new Core.Discovery.TopicIndex();
        this.history = history;
        this.pending = pending ?? new Core.RestartPending();
        this.deployOperator = deployOperator;
        this.modbusDevices = modbusDevices;
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
        // Kestrel's default 32 KB request-header cap returns 431 once cookies pile up.
        builder.WebHost.ConfigureKestrel(k => k.Limits.MaxRequestHeadersTotalSize = 64 * 1024);

        // Before auth is wired: the cookie handler takes the key ring as it is at build time.
        ConfigureDataProtection(builder);

        if (UseOidc)
            ConfigureOidc(builder, gui.Oidc);

        app = builder.Build();

        if (UseOidc)
        {
            // The GUI typically runs behind an ingress/gateway terminating TLS.
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
                // Falling through to disk is better than refusing to start the GUI; say why.
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
            // Code flow defaults to form_post (a cross-site POST callback).
            o.ResponseMode = "query";
            o.UsePkce = true;
            o.CallbackPath = oidc.CallbackPath;
            o.SaveTokens = true;
            o.GetClaimsFromUserInfoEndpoint = true;
            o.Scope.Clear();
            foreach (var scope in (oidc.Scopes ?? "openid profile email").Split(' ', StringSplitOptions.RemoveEmptyEntries))
                o.Scope.Add(scope);

            // Some providers (e.g. Authentik with no signing certificate) sign the id_token with HS256, whose key is not in JWKS.
            if (!string.IsNullOrEmpty(oidc.ClientSecret))
                o.TokenValidationParameters.IssuerSigningKey =
                    new Microsoft.IdentityModel.Tokens.SymmetricSecurityKey(Encoding.UTF8.GetBytes(oidc.ClientSecret));

            // The default correlation/nonce cookies are SameSite=None.
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
                // The header: version, MQTT, config writability, operator update.
                new GuiEventHub.Feed("status", TimeSpan.FromSeconds(5), (_, ct) => BuildStatusAsync(null, ct)),
                // The Status board's cards.
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
        // Settings that were saved but cannot reach this process until it restarts.
        restart = new { required = pending.Required, settings = pending.Settings },
    };

    /// <summary>
    /// Retained discovery configs under our own device-id prefix that this build would not publish today.
    /// </summary>
    private async Task<IReadOnlyList<string>> OrphanedDiscoveryAsync()
    {
        var prefix = config.HASS.DiscoveryTopic;
        if (string.IsNullOrWhiteSpace(prefix)) return Array.Empty<string>();

        var index = topicIndex;
        index.Renew(prefix.Trim().Trim('/') + "/#");
        var retained = (index.Search(null, 5000)).Select(t => t.Topic).ToList();

        // What the exporter would publish right now: every non-synthetic tier not already covered by native PDU discovery.
        var merged = new Models.PDU.PduData();
        foreach (var s in snapshots.All) merged.Devices.AddRange(s.Data.Devices);

        var energyMetric = string.IsNullOrWhiteSpace(config.HASS.EnergyDashboard.EnergyMeasurementType)
            ? "energy" : config.HASS.EnergyDashboard.EnergyMeasurementType;
        var graph = Core.Flow.FlowGraphBuilder.Build(merged, config.EnergyFlow, Core.Flow.FlowGraphBuilder.DefaultMetric, live);
        var native = Core.Flow.FlowExport.NativeEnergyUniqueIds(merged, energyMetric);

        // The same rule the exporter applies.
        var current = Core.Flow.FlowExport.ExportedDeviceIds(graph, config.EnergyFlow.MqttExportTags, native);

        var orphans = Core.Flow.FlowExport.OrphanedDiscoveryTopics(retained, current, prefix).ToList();

        // Native PDU discovery too, which the energyflow sweep deliberately does not touch.
        var published = discovery.PublishedDevices?.Invoke();
        if (published is { HasPublished: true, Ids.Count: > 0 })
        {
            var rootId = string.IsNullOrWhiteSpace(config.Overrides?.rPDU2MQTT?.ID) ? "rPDU2MQTT" : config.Overrides!.rPDU2MQTT!.ID!;
            orphans.AddRange(Core.Flow.FlowExport.OrphanedDiscoveryTopics(retained, published.Value.Ids, prefix, rootId + "_"));
        }

        return orphans;
    }

    private async Task<object> BuildBoardAsync()
    {
        try
        {
            // In-memory board: evaluated when someone looks, so an "…ago" cannot be stale.
            var board = statusBoard?.Board() ?? [];
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

            // OneView group rollups (Sum/Avg/Min/Max per measurement type).
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

    /// <summary>
    /// One value per node per day across a window — the daily totals, kept apart rather than summed.
    /// </summary>
    private async Task<object> BuildSeriesAsync(string? instance, string metric, IReadOnlyList<DateTime> when,
                                                IReadOnlyList<string>? labels, string? partialLabel, CancellationToken ct)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(TimeSpan.FromSeconds(60));
        try
        {
            if (!config.History.Enabled || history is null)
                return new { ok = false, message = "History is not enabled. Turn it on under Features and set a backend." };

            var (id, pdu, _) = ResolveInstance(instance);
            var data = await ResolveData(id, pdu, cts.Token);

            // The shape of the graph comes from the live build — its nodes, labels and kinds.
            var shape = FlowGraphBuilder.Build(data, config.EnergyFlow, metric, live);
            var ids = shape.Nodes.Where(n => !n.Synthetic).Select(n => n.Id).ToList();
            if (ids.Count == 0) return new { ok = false, message = "No nodes to chart yet." };

            // One request where the backend can answer a range.
            var perDay = await history.SeriesAsync(ids, metric, when, cts.Token);

            var series = shape.Nodes
                .Where(n => !n.Synthetic)
                .Select(n => new
                {
                    node = n.Id,
                    label = n.Label,
                    kind = n.Kind,
                    tags = n.Tags,
                    values = perDay.Select(day => day.TryGetValue(n.Id, out var v) ? (double?)v : null).ToList(),
                })
                // A node with nothing across the whole window is not a line on a chart.
                .Where(s => s.values.Any(v => v is not null))
                .ToList();

            if (series.Count == 0)
                return new { ok = false, message = $"No history between {when[0]:u} and {when[^1]:u} from {history.Id}. The backend may not reach that far back, or may not hold this metric." };

            return new
            {
                ok = true,
                metric,
                units = FlowUnits.Canonical(metric),
                source = history.Id,
                // A day is named by the period key the counters re-base on — a server concept.
                days = labels,
                at = when.Select(w => DateTime.SpecifyKind(w, DateTimeKind.Utc)).ToList(),
                // The last bar is a period still in progress.
                partial = partialLabel,
                stepSeconds = when.Count > 1 ? (int)(when[1] - when[0]).TotalSeconds : 0,
                series,
            };
        }
        catch (Exception ex) { return new { ok = false, message = $"Could not build the series: {ex.Message}" }; }
    }

    /// <summary>The energy-flow graph for one instance + metric (the Sankey / Energy Overview source).</summary>
    private async Task<object> BuildFlowAsync(string? instance, string? metric, CancellationToken ct, DateTime? atUtc = null, int spanDays = 1)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(TimeSpan.FromSeconds(20));
        try
        {
            var (id, pdu, _) = ResolveInstance(instance);
            var data = await ResolveData(id, pdu, cts.Token);
            var m = string.IsNullOrEmpty(metric) ? FlowGraphBuilder.DefaultMetric : metric;

            // A past moment is the same graph built from the values of that instant (#372).
            var values = live;
            if (atUtc is { } at)
            {
                // Read the live flag, not whether a provider was wired at startup.
                if (!config.History.Enabled || history is null)
                    return new { ok = false, message = "History is not enabled. Turn it on under Features and set a backend." };

                // The nodes, plus their return lanes.
                var live_ = FlowGraphBuilder.Build(data, config.EnergyFlow, m, live).Nodes
                    .Where(n => !n.Synthetic).Select(n => n.Id).ToList();
                var ids = live_.Concat(live_.Select(id => id + FlowMetricKey.InSuffix)).ToList();

                if (spanDays > 1)
                {
                    // Only the daily total adds up across days.
                    if (m != FlowSpan.SpannableMetric)
                        return new { ok = false, message = $"A span of days only means something for the daily total ({FlowSpan.SpannableMetric}); '{m}' cannot be added across days." };

                    // The same two rules the Trends page uses, for the same reason.
                    var zone = EnergyPeriod.Resolve(config.EnergyFlow.Aggregation.PeriodTimeZone);
                    var when = EnergyPeriod.RecentPeriodEnds(at, zone, config.EnergyFlow.Aggregation.PeriodStartHour, spanDays);
                    var perDay = await history.SeriesAsync(ids, m, when.Select(w => w.AtUtc).ToList(), cts.Token);

                    var (totals, covered) = FlowSpan.Fold(perDay);
                    if (totals.Count == 0)
                        return new { ok = false, message = $"No history for the {spanDays} days to {at:u} from {history.Id}. The backend may not reach that far back, or may not hold this metric." };

                    var graphOverDays = FlowGraphBuilder.Build(data, config.EnergyFlow, m, new HistoricalFlowValueSource(totals, m));
                    return new
                    {
                        ok = true, graphOverDays.Nodes, graphOverDays.Links, graphOverDays.Metric, graphOverDays.Units,
                        at = atUtc, historical = true, source = history.Id, spanDays,
                        // Days a node was missing are days missing from its total.
                        incomplete = FlowSpan.Incomplete(covered, spanDays).Select(x => new { node = x.Node, days = x.Days }).ToList(),
                    };
                }

                var past = await history.ValuesAtAsync(ids, m, at, ct);
                if (past.Count == 0)
                    return new { ok = false, message = $"No history for {at:u} from {history.Id}. The backend may not reach that far back, or may not hold this metric." };
                values = new HistoricalFlowValueSource(past, m);
            }

            var graph = FlowGraphBuilder.Build(data, config.EnergyFlow, m, values);
            return new
            {
                ok = true, graph.Nodes, graph.Links, graph.Metric, graph.Units,
                at = atUtc, historical = atUtc is not null, source = atUtc is null ? null : history?.Id,
            };
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
            // A runtime-loaded plugin's settings class becomes a page here, with no UI shipped by the
            // plugin: the form is drawn from this schema, which is generated by reflection rather than
            // compiled into the bundle.
            var schema = ConfigSchema.Build(pluginSections?.Sections ?? []);
            // Under Kubernetes, logging is driven by the platform (stdout + the pod spec).
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
                // What this process is running, before any of it is replaced below.
                var stranded = ConfigApply.NeedingRestart(config, parsed);

                await configSource.SaveAsync(parsed, ctx.RequestAborted);
                Log.Information($"Configuration saved via GUI to {configSource.Describe}.");

                // Re-read the just-saved config so live-readable settings take effect without a restart.
                var reloaded = configSource.Load();
                // The energy-flow hierarchy is read fresh on every /api/flow request.
                config.EnergyFlow = reloaded.EnergyFlow;
                // Likewise the HA Energy-Dashboard settings (URL/token/enable).
                config.HASS.EnergyDashboard = reloaded.HASS.EnergyDashboard;
                // And the EmonCMS feed-provisioning settings.
                config.EmonCMS.Feeds = reloaded.EmonCMS.Feeds;
                // And the history backend: FlowHistoryRouter reads the provider and its settings per call.
                config.History = reloaded.History;

                // Apply PDU instance add/remove live: refresh the instance set from the saved config.
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

                pending.Set(stranded);

                var message = (configSource.IsGitOpsManaged
                    ? "Saved to the Kubernetes resource (remember to update your GitOps source so it doesn't drift). Credentials are stored in the companion Secret. Press 'Republish discovery' to apply override/name/template changes; restart for primary connection/credential changes (incl. OIDC)."
                    : "Saved. Press 'Republish discovery' to apply override/name/template changes; restart the service for primary connection changes (host/port).") + instanceMessage;
                return Results.Json(new
                {
                    ok = true,
                    message,
                    gitops = configSource.IsGitOpsManaged,
                    // So the GUI can offer the restart then and there, and name what is waiting on it.
                    restartRequired = stranded.Count > 0,
                    restartSettings = stranded,
                }, ConfigSchema.Json);
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

        // A handler taking HttpContext must use a statement body with `return` (see the RouteHandlersReturnTheirResults test).
        app.MapGet("/api/status", async (HttpContext ctx) =>
        {
            return Results.Json(await BuildStatusAsync(UseOidc ? ctx.User?.Identity?.Name : null, ctx.RequestAborted), ConfigSchema.Json);
        });

        // One push channel for the whole GUI (#281): the browser opens a single EventSource.
        app.MapGet("/api/events", (HttpContext ctx) => EventHub().StreamAsync(ctx, ctx.Request.Query["topics"].ToString()));

        // "Check now" from the header: the operator runs in a separate process.
        app.MapPost("/api/operator/check", async (HttpContext ctx) =>
        {
            if (configSource is not KubernetesConfigSource)
                return Results.Json(new { ok = false, message = "Update checks are only available with the Kubernetes config source." }, ConfigSchema.Json);
            try
            {
                var report = await Operator(op => op.CheckNow(force: true), new Core.Operator.OperatorReport { Message = "The operator is not available in this deployment." });
                return Results.Json(new { ok = true, message = report.Message ?? "Checked.", update = report }, ConfigSchema.Json);
            }
            catch (Exception ex) { return Results.Json(new { ok = false, message = $"Could not request a check: {ex.Message}" }, ConfigSchema.Json); }
        });

        // Tags available for the deployed image, so the Operator page can offer a channel/version switch.
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
                var msg = await Operator(op => op.SetTag(tag), "The operator is not available in this deployment.");
                return Results.Json(new { ok = true, message = msg }, ConfigSchema.Json);
            }
            catch (Exception ex) { return Results.Json(new { ok = false, message = $"Could not request the switch: {ex.Message}" }, ConfigSchema.Json); }
        });

        // Force update: re-pull the currently-deployed tag now.
        app.MapPost("/api/operator/redeploy", async (HttpContext ctx) =>
        {
            if (configSource is not KubernetesConfigSource)
                return Results.Json(new { ok = false, message = "Force update needs the Kubernetes config source + the operator role." }, ConfigSchema.Json);
            try
            {
                var msg = await Operator(op => op.Redeploy(), "The operator is not available in this deployment.");
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
        app.MapGet("/api/time", () =>
        {
            var agg = config.EnergyFlow.Aggregation;
            var now = DateTime.UtcNow;
            var configured = agg.PeriodTimeZone;
            // Resolve without warning: the log has already said so once at startup.
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

        // The Status board: every hop's card as the board judged it. The verdicts —
        app.MapGet("/api/status/board", async () => Results.Json(await BuildBoardAsync(), ConfigSchema.Json));

        // Diagnostics: versions, uptime, runtime, and Kubernetes context for the Diagnostics page.
        app.MapGet("/api/diagnostics", async (HttpContext ctx) =>
        {
            var k8s = configSource as KubernetesConfigSource;

            // Operator update report (#210), if the operator has written one to the CR status.
            var update = await ReadOperatorUpdateAsync(k8s, ctx.RequestAborted);

            // The process list (the registry, replacing the MQTT heartbeat).
            var processList = processes?.Active() ?? [];

            // EmonCMS export health. The exporter runs only on the worker.
            object? emonStatus = null;
            if (config.EmonCMS.Enabled)
            {
                if (emonCmsStatus.HasAttempted)
                    emonStatus = emonCmsStatus.Snapshot();
                else
                    emonStatus = processList
                        .Where(p => p.EmonCms is not null && (DateTime.UtcNow - p.TimestampUtc).TotalSeconds <= Core.Diagnostics.ProcessRegistry.StaleAfterSeconds)
                        .OrderByDescending(p => p.TimestampUtc)
                        .Select(p => (object?)p.EmonCms)
                        .FirstOrDefault() ?? emonCmsStatus.Snapshot();
            }

            // Modbus source health: for each configured connection.
            var modbus = new List<object>();
            foreach (var conn in config.Modbus.Connections)
            {
                if (!conn.Enabled || string.IsNullOrWhiteSpace(conn.Host)) continue;
                {
                    if (modbusDevices?.For(conn.Host, conn.Port, conn.UnitId) is not { } h) continue;
                    long? okAge = h.LastOkUtc is { } okAt ? (long)Math.Max(0, (DateTime.UtcNow - okAt).TotalSeconds) : null;
                    var stale = h.LastOkUtc is null || (h.PollIntervalSeconds > 0 && okAge > Math.Max(30, h.PollIntervalSeconds * 3));
                    modbus.Add(new
                    {
                        id = conn.Id, name = conn.Name ?? conn.Id, host = $"{conn.Host}:{conn.Port}", unitId = conn.UnitId,
                        bindings = h.Bindings, values = h.LastValueCount, lastOkAgeSeconds = okAge, error = h.LastError, stale,
                    });
                }
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
                // Component health: which workloads this process runs.
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
                            stale = age > Core.Diagnostics.ProcessRegistry.StaleAfterSeconds,
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

        // Each configured node's rolled-up value, per metric.
        //
        // This used to be served by a parallel roll-up recomputing the same
        // hierarchy the graph builder computes, whose ONLY consumer was this endpoint. Two implementations
        // of one calculation, and the one nobody else read was the one shown on the diagnostics panel — so
        // a disagreement between them would have surfaced here as the truth.
        app.MapGet("/api/flow/tree", (HttpContext ctx) =>
        {
            try
            {
                var merged = new Models.PDU.PduData();
                foreach (var s in snapshots.All) merged.Devices.AddRange(s.Data.Devices);

                var nodes = Core.Flow.FlowTiers.Graphs(merged, config, live)
                    .SelectMany(g => g.Graph.Nodes
                        .Where(n => !n.Synthetic && n.Value is not null)
                        .Select(n => new { node = n.Id, metric = g.Metric, value = n.Value!.Value }))
                    .GroupBy(x => x.node)
                    .OrderBy(g => g.Key)
                    .Select(g => new { node = g.Key, metrics = g.Select(x => new { metric = x.metric, value = (double?)x.value }).ToArray() })
                    .ToArray();

                return Results.Json(new { ok = true, version = nodes.Length, nodes }, ConfigSchema.Json);
            }
            catch (Exception ex)
            {
                return Results.Json(new { ok = false, message = ex.Message }, ConfigSchema.Json);
            }
        });

        // Restart a tier — or everything.
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
                    // Only the tiers of a split deployment need their own button.
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
            var procs = processes?.Active() ?? [];
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

        // Browse what's on the broker, for the Nodes editor's topic autocomplete.
        app.MapGet("/api/ha/devices/stale", async () =>
        {
            try
            {
                var stale = await haEnergy.StaleDevicesAsync();
                return Results.Json(new
                {
                    ok = true,
                    devices = stale.Select(d => new { d.Id, d.Name, identifiers = d.Identifiers }).ToArray(),
                }, ConfigSchema.Json);
            }
            catch (Exception ex) { return Results.Json(new { ok = false, message = ex.Message }, ConfigSchema.Json); }
        });

        app.MapPost("/api/ha/devices/stale/delete", async (HttpContext ctx) =>
        {
            try
            {
                // Re-read rather than trusting a list the browser has been holding.
                var stale = await haEnergy.StaleDevicesAsync();

                // An optional id list lets the caller work through them in batches.
                System.Text.Json.Nodes.JsonNode? body = null;
                try
                {
                    using var reader = new StreamReader(ctx.Request.Body);
                    var raw = await reader.ReadToEndAsync();
                    if (!string.IsNullOrWhiteSpace(raw)) body = System.Text.Json.Nodes.JsonNode.Parse(raw);
                }
                catch { /* no body, or not JSON: fall through and delete everything stale */ }

                if (body?["ids"]?.AsArray() is { } wanted && wanted.Count > 0)
                {
                    var ids = new HashSet<string>(wanted.Select(n => (string?)n ?? ""), StringComparer.Ordinal);
                    stale = stale.Where(d => ids.Contains(d.Id)).ToList();
                }

                var removed = await haEnergy.DeleteDevicesAsync(stale);
                if (removed > 0) Log.Information($"Deleted {removed} stale Home Assistant device registration(s) at the operator's request.");
                return Results.Json(new { ok = true, deleted = stale.Count, removed }, ConfigSchema.Json);
            }
            catch (Exception ex) { return Results.Json(new { ok = false, message = ex.Message }, ConfigSchema.Json); }
        });

        // Retained Home Assistant discovery configs this build would no longer publish — and, on POST.
        async Task<IReadOnlyList<Core.Discovery.TopicSample>> ScanAsync(string filter, CancellationToken ct)
        {
            var index = topicIndex;
            return await Core.Flow.TopicIndexScan.SettleAsync<Core.Discovery.TopicSample>(
                // The index is synchronous now, so these adapt it to the helper's async shape rather than
                // the helper pretending an in-memory dictionary needs awaiting.
                renew: () => { index.Renew(filter); return Task.CompletedTask; },
                search: () => Task.FromResult<IReadOnlyList<Core.Discovery.TopicSample>>(index.Search(null, 5000)),
                delay: d => Task.Delay(d, ct),
                pollEvery: TimeSpan.FromMilliseconds(750),
                deadline: DateTime.UtcNow.AddSeconds(12),
                now: () => DateTime.UtcNow,
                ct: ct);
        }

        // Power/energy readings other integrations already announce over Home Assistant MQTT discovery.
        app.MapGet("/api/mqtt/importable", async (HttpContext ctx) =>
        {
            try
            {
                var prefix = config.HASS.DiscoveryTopic;
                if (string.IsNullOrWhiteSpace(prefix))
                    return Results.Json(new { ok = false, message = "No Home Assistant discovery prefix is configured, so there is nothing to scan." }, ConfigSchema.Json);

                var retained = await ScanAsync(prefix.Trim().Trim('/') + "/#", ctx.RequestAborted);

                var rootId = string.IsNullOrWhiteSpace(config.Overrides?.rPDU2MQTT?.ID) ? "rPDU2MQTT" : config.Overrides!.rPDU2MQTT!.ID!;
                string[] ours = [Core.Flow.FlowExport.DeviceIdPrefix, rootId + "_"];

                var found = retained
                    .Where(t => t.Topic.EndsWith("/config", StringComparison.OrdinalIgnoreCase))
                    .SelectMany(t => Core.Flow.MqttDiscoveryImport.Parse(t.Payload ?? "", ours))
                    .GroupBy(r => r.UniqueId, StringComparer.OrdinalIgnoreCase)
                    .Select(g => g.First())
                    .OrderBy(r => r.Device, StringComparer.OrdinalIgnoreCase)
                    .ThenBy(r => r.Label, StringComparer.OrdinalIgnoreCase)
                    .ToList();

                return Results.Json(new
                {
                    ok = true,
                    scanned = retained.Count,
                    readings = found.Select(r => new
                    {
                        id = Core.Flow.MqttDiscoveryImport.NodeId(r.UniqueId),
                        uniqueId = r.UniqueId, label = r.Label, device = r.Device,
                        topic = r.StateTopic, metric = r.Metric, unit = r.Unit,
                        units = Core.Flow.FlowUnits.UnitsFor(r.Metric),
                        canonicalUnit = Core.Flow.FlowUnits.Canonical(r.Metric),
                        jsonField = r.JsonField, unsupported = r.Unsupported,
                    }),
                }, ConfigSchema.Json);
            }
            catch (Exception ex) { return Results.Json(new { ok = false, message = ex.Message }, ConfigSchema.Json); }
        });

        // Readings matched by topic shape, for publishers that do not announce Home Assistant discovery.
        app.MapGet("/api/mqtt/importable/pattern", async (HttpContext ctx) =>
        {
            try
            {
                var profile = Core.Flow.MqttTopicProfile.Resolve(ctx.Request.Query["profile"].ToString(), config.MQTT.ImportProfiles);
                if (profile is null)
                    return Results.Json(new { ok = false, message = "Unknown topic profile." }, ConfigSchema.Json);

                var samples = await ScanAsync(profile.Filter, ctx.RequestAborted);

                var matches = Core.Flow.MqttTopicProfile.Scan(
                    profile, samples.Select(t => (t.Topic, t.Payload)));

                return Results.Json(new
                {
                    ok = true,
                    scanned = samples.Count,
                    profile = profile.Id,
                    readings = matches.Select(m => new
                    {
                        id = Core.Flow.MqttDiscoveryImport.NodeId($"{profile.Id}_{m.Device}_{m.Measure}"),
                        label = $"{m.Device} {m.Measure}",
                        device = m.Device,
                        topic = m.Topic, metric = m.Metric, unit = (string?)null,
                        units = Core.Flow.FlowUnits.UnitsFor(m.Metric ?? ""),
                        canonicalUnit = Core.Flow.FlowUnits.Canonical(m.Metric ?? ""),
                        jsonField = m.JsonField, sample = m.Sample, unsupported = (string?)null,
                    }),
                }, ConfigSchema.Json);
            }
            catch (Exception ex) { return Results.Json(new { ok = false, message = ex.Message }, ConfigSchema.Json); }
        });

        // One profile's full definition, for copying a built-in into MQTT.ImportProfiles to edit.
        app.MapGet("/api/mqtt/profile", (HttpContext ctx) =>
        {
            var p = Core.Flow.MqttTopicProfile.Resolve(ctx.Request.Query["id"].ToString(), config.MQTT.ImportProfiles);
            if (p is null) return Results.Json(new { ok = false, message = "Unknown topic profile." }, ConfigSchema.Json);
            return Results.Json(new
            {
                ok = true,
                profile = new { id = p.Id, label = p.Label, filter = p.Filter, pattern = p.Pattern, jsonField = p.JsonField, metrics = p.Metrics },
            }, ConfigSchema.Json);
        });

        app.MapGet("/api/mqtt/profiles", () => Results.Json(new
        {
            ok = true,
            profiles = Core.Flow.MqttTopicProfile.BuiltIn
                .Select(p => new { id = p.Id, label = p.Label, pattern = p.Pattern })
                .Concat((config.MQTT.ImportProfiles ?? new())
                    .Where(p => !string.IsNullOrWhiteSpace(p.Name) && !string.IsNullOrWhiteSpace(p.Pattern))
                    .Select(p => new { id = "custom:" + p.Name, label = p.Name, pattern = p.Pattern })),
        }, ConfigSchema.Json));

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
                // An empty retained payload is how MQTT deletes a retained message.
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
                var index = topicIndex;
                // The filter to browse (default '#'); a restricted broker can narrow it, e.g. 'solar_assistant/#'.
                var filter = ctx.Request.Query["filter"].FirstOrDefault();
                var state = index.Renew(filter);
                var q = ctx.Request.Query["q"].FirstOrDefault();
                var limit = int.TryParse(ctx.Request.Query["limit"].FirstOrDefault(), out var n) ? n : 50;

                var topics = (index.Search(q, limit)).Select(t =>
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

                // "listening" tells the editor whether anything is feeding the index yet.
                return Results.Json(new { ok = true, listening = state.Listening, indexed = state.Topics, capacity = state.Capacity, filter = state.Filter, granted = state.Granted, topics }, ConfigSchema.Json);
            }
            catch (Exception ex) { return Results.Json(new { ok = false, message = ex.Message }, ConfigSchema.Json); }
        });

        // One topic's last payload and what it implies — the metric/unit to bind.
        app.MapGet("/api/mqtt/topic", async (HttpContext ctx) =>
        {
            try
            {
                var topic = ctx.Request.Query["topic"].FirstOrDefault() ?? "";
                var index = topicIndex;
                index.Renew(null);   // keep the current browse filter alive; we only want one topic's detail
                var sample = index.Get(topic);
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

        // Read a block of registers off a Modbus device — the explorer behind "Browse registers".
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

                // Each register is read as uint16 and int16, and each pair additionally as float32/int32.
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

        // Probe a Modbus TCP device: connect, and optionally read a set of register specs.
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

        // Current live value per (node, metric) as the running ingests hold it.
        app.MapPost("/api/flow/live", async (HttpContext ctx) =>
        {
            try
            {
                var reqs = await System.Text.Json.JsonSerializer.DeserializeAsync<List<LiveValueQuery>>(
                    ctx.Request.Body, ProbeJson, ctx.RequestAborted) ?? new();
                // `value` keeps its meaning exactly: the reading only if it can still be believed.
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

        // Does the history backend actually answer?
        app.MapPost("/api/test/history", async (HttpContext ctx) =>
        {
            if (!config.History.Enabled)
                return Results.Json(new { ok = false, message = "History is turned off. Enable it under Features." }, ConfigSchema.Json);
            if (history is null)
                return Results.Json(new { ok = false, message = "No history backend is wired in this process." }, ConfigSchema.Json);
            try
            {
                // Asks a question no single integration can: "is the backend the History setting SELECTED
                // answering?" — the answer changes when that setting changes, not when an integration does.
                // But it is not a second implementation: the selected provider is an integration, so its own
                // probe is what runs, and this endpoint only resolves which one that is.
                var selected = integrations?.ById(config.History.Provider);
                if (selected is not null)
                {
                    var (sok, sdetail) = await selected.ProbeAsync(config, ctx.RequestAborted);
                    return Results.Json(new { ok = sok, message = $"{selected.DisplayName}: {sdetail}" }, ConfigSchema.Json);
                }

                var (ok, detail) = await history.ProbeAsync(ctx.RequestAborted);
                return Results.Json(new { ok, message = ok ? $"{history.Id}: reachable — {detail}" : $"{history.Id}: {detail}" }, ConfigSchema.Json);
            }
            catch (Exception ex) { return Results.Json(new { ok = false, message = ex.Message }, ConfigSchema.Json); }
        });

        // HA Energy Mapping (#128): push the current hierarchy into HA's Energy Dashboard now, or clear it.
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

        // --- Integrations: one route shape for every one of them, built-in or plugin ------------------
        // What an integration can do is derived from the capabilities it declares (probe / publish / sweep)
        // plus whatever it adds through IIntegrationApi — so a plugin dropped into plugins/ is reachable
        // here without a line of routing written for it.

        // Everything that can offer nodes to adopt, asked at once. Discovery only — this never writes a
        // node; what is adopted and what it is called stay the operator's.
        app.MapGet("/api/discover/nodes", async (HttpContext ctx) =>
        {
            var search = ctx.Request.Query["q"].ToString();
            var found = new List<object>();
            foreach (var provider in nodeProviders)
            {
                try
                {
                    foreach (var n in await provider.DiscoverAsync(config, search, ctx.RequestAborted))
                        found.Add(new { key = n.Key, label = n.Label, metric = n.Metric, unit = n.Unit, sample = n.Sample, kind = n.Kind, suggestedId = n.SuggestedId });
                }
                catch (Exception ex)
                {
                    // One provider that cannot answer must not empty the picker for the others.
                    Log.Debug($"Node discovery from {provider.GetType().Name} failed: {ex.Message}");
                }
            }
            return Results.Json(new { ok = true, nodes = found }, ConfigSchema.Json);
        });

        app.MapGet("/api/integrations", () =>
        {
            if (integrations is null) return Results.Json(new { ok = false, integrations = Array.Empty<object>() }, ConfigSchema.Json);
            var list = integrations.All.Select(i => new
            {
                id = i.Id,
                name = i.DisplayName,
                group = i.Group.ToString(),
                enabled = i.Enabled(config),
                fault = i.Misconfigured(config),
                capabilities = Core.Integrations.IntegrationRegistry.Capabilities(i),
                actions = Core.Integrations.IntegrationActions.For(i, CurrentPass).Select(a => new
                {
                    name = a.Name, title = a.Title, description = a.Description, effect = a.Effect.ToString().ToLowerInvariant(),
                }),
            });
            return Results.Json(new { ok = true, integrations = list }, ConfigSchema.Json);
        });

        app.MapPost("/api/integrations/{id}/{action}", async (string id, string action, HttpContext ctx) =>
        {
            if (integrations is null) return Results.Json(new { ok = false, message = "No integration registry in this process." }, ConfigSchema.Json);

            var integration = integrations.ById(id);
            if (integration is null) return Results.Json(new { ok = false, message = $"No integration called '{id}'." }, ConfigSchema.Json);

            var found = Core.Integrations.IntegrationActions.Find(integration, action, CurrentPass);
            if (found is null) return Results.Json(new { ok = false, message = $"'{integration.DisplayName}' has no action called '{action}'." }, ConfigSchema.Json);

            // Query string and form fields, flattened — an action never sees HttpContext.
            var args = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
            foreach (var (k, v) in ctx.Request.Query) args[k] = v.ToString();
            if (ctx.Request.HasFormContentType)
                foreach (var (k, v) in await ctx.Request.ReadFormAsync()) args[k] = v.ToString();

            try
            {
                var result = await found.Handler(new Core.Integrations.IntegrationActionContext(config, args), ctx.RequestAborted);
                return Results.Json(new { ok = true, result }, ConfigSchema.Json);
            }
            catch (Exception ex)
            {
                return Results.Json(new { ok = false, message = $"{integration.DisplayName} · {found.Title} failed: {ex.Message}" }, ConfigSchema.Json);
            }
        });

        // Live discovered structure (keys + current names) for the Overrides editor.
        app.MapGet("/api/live", async (HttpContext ctx) =>
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ctx.RequestAborted);
            cts.CancelAfter(TimeSpan.FromSeconds(20));
            try
            {
                var (id, pdu, _) = ResolveInstance(ctx.Request.Query["instance"]);
                var data = await ResolveData(id, pdu, cts.Token);

                // The raw PDU label/name plus the currently-discovered display name and object_id.
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

        // Generated integration paths per measurement: MQTT topic, Prometheus metric, EmonCMS key.
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
            // ?at=<ISO-8601> renders the moment instead of now.
            DateTime? at = DateTime.TryParse(ctx.Request.Query["at"].ToString(), null,
                System.Globalization.DateTimeStyles.AdjustToUniversal | System.Globalization.DateTimeStyles.AssumeUniversal, out var parsed)
                ? parsed : null;
            // ?span=<days> sums that many daily totals, ending at ?at.
            var span = int.TryParse(ctx.Request.Query["span"].ToString(), out var d) ? Math.Clamp(d, 1, 366) : 1;
            return Results.Json(await BuildFlowAsync(ctx.Request.Query["instance"], ctx.Request.Query["metric"].ToString(), ctx.RequestAborted, at, span), ConfigSchema.Json);
        });

        // One value per node per day over a window — what the Trends page charts.
        app.MapGet("/api/flow/series", async (HttpContext ctx) =>
        {
            DateTime end = DateTime.TryParse(ctx.Request.Query["at"].ToString(), null,
                System.Globalization.DateTimeStyles.AdjustToUniversal | System.Globalization.DateTimeStyles.AssumeUniversal, out var parsed)
                ? parsed : DateTime.UtcNow;

            // Two shapes of question, and they are not the same question.
            if (ctx.Request.Query["today"] == "1")
            {
                var dayZone = EnergyPeriod.Resolve(config.EnergyFlow.Aggregation.PeriodTimeZone);
                // ?back=<n> charts a whole earlier period instead — yesterday is back=1.
                var back = int.TryParse(ctx.Request.Query["back"].ToString(), out var bk) ? Math.Clamp(bk, 0, 366) : 0;
                (var began, end) = EnergyPeriod.Window(end, dayZone, config.EnergyFlow.Aggregation.PeriodStartHour, back);
                var stepToday = int.TryParse(ctx.Request.Query["step"].ToString(), out var ts) ? Math.Clamp(ts, 60, 3600) : 300;
                var metricToday = string.IsNullOrWhiteSpace(ctx.Request.Query["metric"]) ? FlowGraphBuilder.DefaultMetric : ctx.Request.Query["metric"].ToString();
                var sinceStart = new List<DateTime>();
                for (var t = began; t <= end; t = t.AddSeconds(stepToday)) sinceStart.Add(t);
                if (sinceStart.Count == 0) sinceStart.Add(end);
                return Results.Json(await BuildSeriesAsync(ctx.Request.Query["instance"], metricToday, sinceStart,
                    null, null, ctx.RequestAborted), ConfigSchema.Json);
            }

            if (int.TryParse(ctx.Request.Query["minutes"].ToString(), out var mins))
            {
                var step = int.TryParse(ctx.Request.Query["step"].ToString(), out var st) ? Math.Clamp(st, 60, 3600) : 300;
                var span = TimeSpan.FromMinutes(Math.Clamp(mins, 5, 60 * 48));
                var metricNow = string.IsNullOrWhiteSpace(ctx.Request.Query["metric"]) ? FlowGraphBuilder.DefaultMetric : ctx.Request.Query["metric"].ToString();
                var steps = new List<DateTime>();
                for (var t = end - span; t <= end; t = t.AddSeconds(step)) steps.Add(t);
                // No labels: a moment within a day is named in the viewer's zone.
                return Results.Json(await BuildSeriesAsync(ctx.Request.Query["instance"], metricNow, steps,
                    null, null, ctx.RequestAborted), ConfigSchema.Json);
            }

            var days = int.TryParse(ctx.Request.Query["days"].ToString(), out var d) ? Math.Clamp(d, 2, 92) : 30;
            var metric = string.IsNullOrWhiteSpace(ctx.Request.Query["metric"]) ? FlowSpan.SpannableMetric : ctx.Request.Query["metric"].ToString();

            // Each day read at its own rollover, not at whatever time of day it happens to be now.
            var zone = EnergyPeriod.Resolve(config.EnergyFlow.Aggregation.PeriodTimeZone);
            var periods = EnergyPeriod.RecentPeriodEnds(end, zone, config.EnergyFlow.Aggregation.PeriodStartHour, days);
            return Results.Json(await BuildSeriesAsync(ctx.Request.Query["instance"], metric,
                periods.Select(p => p.AtUtc).ToList(), periods.Select(p => p.Day).ToList(),
                periods[^1].Complete ? null : periods[^1].Day, ctx.RequestAborted), ConfigSchema.Json);
        });

        // Which metrics history can be asked for, so the page offers the ones that were actually exported
        // rather than a hardcoded guess. Units come with them: whether a bar is a rate or a quantity decides
        // what arithmetic the page is allowed to do on it.
        app.MapGet("/api/flow/metrics", () => Results.Json(new
        {
            ok = true,
            metrics = FlowTiers.Metrics(config).Select(m => new { metric = m, units = FlowUnits.Canonical(m) }),
        }, ConfigSchema.Json));

        // Readings the bridge is deliberately dropping, and why.
        app.MapGet("/api/flow/withheld", (HttpContext ctx) =>
        {
            var withheld = (live as Core.Flow.IWithheldSources)?.Withheld ?? Array.Empty<Core.Flow.WithheldSource>();
            return Results.Json(new
            {
                ok = true,
                sources = withheld.Select(w => new { node = w.Node, source = w.Source, metric = w.Metric, reason = w.Reason }),
            }, ConfigSchema.Json);
        });

        // Preview the generated paths with the posted (unsaved) config applied.
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
                    // Resolve through the pending-write latch so a value just set here shows immediately.
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
                // PDUs and their circuits (breaker entities), with editable labels.
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
                // Through the write seam, not the Vertiv client directly: the seam is what routes a
                // plugin-supplied device's outlet to the plugin that owns it. Calling the client meant this
                // page could only ever switch a Vertiv PDU, however the device got here.
                else if (outletControl is not null)
                {
                    // Report what the write DID. Answering ok to a refusal is how a button that does
                    // nothing looks like it worked, and the outlet is still on when the page refreshes.
                    var wrote = await outletControl.Control(req.DeviceId, req.Index, action, cts.Token);
                    return Results.Json(
                        new { ok = wrote.Ok, message = wrote.Ok ? $"Outlet {req.Index + 1} → {action}." : wrote.Message },
                        ConfigSchema.Json);
                }
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
            // The live flag, not whether a service happens to be registered.
            if (!config.HASS.DiscoveryEnabled)
                return Results.Json(new { ok = false, message = "Home Assistant discovery is turned off. Turn it on and save; no restart needed." }, ConfigSchema.Json);

            await discovery.RequestRediscoverAsync(CancellationToken.None);
            return Results.Json(new { ok = true, message = "Discovery republish requested." }, ConfigSchema.Json);
        });

        app.MapPost("/api/discovery/clear", async () =>
        {
            // Deliberately NOT gated on DiscoveryEnabled.

            // First the services' own clear: each forgets and retracts what it published this run.
            await discovery.RequestClearAsync(CancellationToken.None);

            // Then everything else of ours still retained on the broker.
            var swept = 0;
            var message = "Cleared the retained Home Assistant discovery messages.";
            try
            {
                var prefix = config.HASS.DiscoveryTopic;
                var root = (prefix ?? "").Trim().Trim('/');
                var index = topicIndex;

                // The index only fills while someone is reading it.
                var state = index.Renew(root + "/#");
                for (var i = 0; i < 30 && !(state.Listening && state.Granted != false); i++)
                {
                    await Task.Delay(500);
                    state = index.Renew(root + "/#");
                }
                if (state.Granted == false)
                    throw new InvalidOperationException($"the broker refused a subscription to '{root}/#', so what is retained there cannot be read");
                if (!state.Listening)
                    throw new InvalidOperationException("no process is feeding the topic index, so what is retained on the broker cannot be read");
                await Task.Delay(2000);   // retained messages arrive in a burst; let it finish

                // Uncapped on purpose: Search caps at 200 and orders by topic length.
                var retained = index.TopicsUnder(root + "/");

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
                // The services' own clear already succeeded.
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
        try { return await Operator(op => op.Status(), new Core.Operator.OperatorReport { Message = "No check yet." }); }
        catch (Exception ex) { Log.Debug($"Could not read the operator's status: {ex.Message}"); return null; }
    }

    /// <summary>
    /// Ask the operator, or answer for it. There is no operator outside Kubernetes, so every caller needs
    /// the same "it isn't here" answer — stated once, rather than each endpoint inventing its own.
    /// </summary>
    private Task<T> Operator<T>(Func<Core.Operator.IOperatorControl, Task<T>> ask, T absent)
        => deployOperator is null ? Task.FromResult(absent) : ask(deployOperator);

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

    /// <summary>
    /// The export pass as it stands right now, for actions that need to know what exists — publishing
    /// configuration describes the nodes and devices there are. Null when nothing has been polled and no
    /// hierarchy is configured, so a publish declines rather than telling the far end everything is gone.
    /// </summary>
    private Core.Integrations.ExportPass? CurrentPass()
    {
        try
        {
            var fresh = snapshots.All.ToList();
            var pass = Core.Integrations.ExportPass.Build(fresh, config, live);
            return pass.IsEmpty ? null : pass;
        }
        catch { return null; }
    }

}
