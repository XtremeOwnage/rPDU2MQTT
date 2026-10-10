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

/// <summary>Embedded web GUI for viewing, editing and testing the configuration.</summary>
public sealed partial class GuiService : IHostedService, IAsyncDisposable
{
    private readonly Config config;
    private readonly IHiveMQClient mqtt;
    private readonly DiscoveryCoordinator discovery;
    private readonly IConfigSource configSource;
    private readonly IHostApplicationLifetime lifetime;
    private readonly HealthState health;
    private readonly Core.Integrations.IPduInstances registry;
    private readonly Core.Integrations.IntegrationStatus? integrationStatus;
    private readonly Core.IProcessRestarter? restarter;
    private readonly Core.ISnapshotCache snapshots;
    private readonly Core.HostRole hostRoles;
    private readonly HaEnergyDashboardSync haEnergy;
    private readonly Core.Flow.IFlowValueSource? live;
    // Config sections contributed by loaded plugins.
    private readonly PluginSchemaSections? pluginSections;
    // Every plugin found at startup, loaded or not.
    private readonly rPDU2MQTT.Plugins.PluginCatalog? pluginCatalog;
    // Every integration, built-in or from plugins.
    private readonly Core.Integrations.IntegrationRegistry? integrations;
    // Write seam: routes to the owning PDU or plugin.
    private readonly Abstractions.Pdu.IOutletControl? outletControl;
    // Sources of nodes to adopt.
    private readonly IReadOnlyList<Core.Integrations.INodeProvider> nodeProviders;
    private readonly Core.Status.StatusBoard? statusBoard;
    private readonly Core.Diagnostics.ProcessRegistry? processes;
    private readonly Core.Discovery.TopicIndex topicIndex;
    private readonly Core.Flow.IMeasurementHistory? history;
    private readonly Core.History.LocalSeriesStore? localHistory;
    private readonly HistoryCopyService? historyCopy;
    // Settings the last save could not apply to this process.
    private readonly Core.RestartPending pending;
    private static readonly HttpClient testHttp = new() { Timeout = TimeSpan.FromSeconds(15) };
    private WebApplication? app;
    // Created on the first /api/events connection.
    private GuiEventHub? events;
    private readonly object eventsGate = new();

    // Deployment operator, when running under Kubernetes.
    private readonly Core.Operator.IOperatorControl? deployOperator;
    // Last outcome per Modbus device, for diagnostics.
    private readonly Core.Modbus.ModbusDevices? modbusDevices;

    public GuiService(Config config, IHiveMQClient mqtt, DiscoveryCoordinator discovery, IConfigSource configSource, IHostApplicationLifetime lifetime, HealthState health, Core.Integrations.IPduInstances registry, Core.ISnapshotCache snapshots, Core.HostRole hostRoles, HaEnergyDashboardSync haEnergy, Core.Flow.IFlowValueSource? live = null, Core.IProcessRestarter? restarter = null, Core.Flow.IMeasurementHistory? history = null, Core.RestartPending? pending = null, PluginSchemaSections? pluginSections = null, Core.Integrations.IntegrationRegistry? integrations = null, Abstractions.Pdu.IOutletControl? outletControl = null, IEnumerable<Core.Integrations.INodeProvider>? nodeProviders = null, Core.Status.StatusBoard? statusBoard = null, Core.Diagnostics.ProcessRegistry? processes = null, Core.Discovery.TopicIndex? topicIndex = null, Core.Operator.IOperatorControl? deployOperator = null, Core.Modbus.ModbusDevices? modbusDevices = null, Core.Plans.IPlanImageStore? cachePlans = null, Core.History.LocalSeriesStore? localHistory = null, HistoryCopyService? historyCopy = null, rPDU2MQTT.Plugins.PluginCatalog? pluginCatalog = null, Core.Integrations.IntegrationStatus? integrationStatus = null)
    {
        this.pluginCatalog = pluginCatalog;
        this.live = live;
        this.pluginSections = pluginSections;
        this.integrations = integrations;
        this.outletControl = outletControl;
        this.nodeProviders = nodeProviders?.ToList() ?? [];
        this.statusBoard = statusBoard;
        this.processes = processes;
        this.topicIndex = topicIndex ?? new Core.Discovery.TopicIndex();
        this.history = history;
        this.localHistory = localHistory;
        this.historyCopy = historyCopy;
        this.pending = pending ?? new Core.RestartPending();
        this.deployOperator = deployOperator;
        this.modbusDevices = modbusDevices;
        this.config = config;
        this.mqtt = mqtt;
        this.discovery = discovery;
        this.configSource = configSource;
        this.lifetime = lifetime;
        this.health = health;
        this.registry = registry;
        this.integrationStatus = integrationStatus;
        this.restarter = restarter;
        this.snapshots = snapshots;
        this.hostRoles = hostRoles;
        this.cachePlans = cachePlans;
        this.haEnergy = haEnergy;
    }

    private const string NoPdu = "No PDU instance configured.";

    /// <summary>Current data for an instance from the snapshot cache, else a direct poll.</summary>
    private async Task<Models.PDU.PduData> ResolveData(string id, Core.Integrations.IPduInstance? pdu, CancellationToken ct) =>
        snapshots.Get(id)?.Data ?? (pdu is null ? new Models.PDU.PduData() : await pdu.ReadAsync(ct));

    /// <summary>The instance id a request targets, else the primary's.</summary>
    private string ResolveInstanceId(string? requested) =>
        !string.IsNullOrEmpty(requested) && registry.All.ContainsKey(requested)
            ? requested
            : registry.PrimaryId ?? Config.DefaultInstanceKey;

    /// <summary>Resolve the PDU and its config from <c>?instance=</c> or a body field.</summary>
    private (string Id, Core.Integrations.IPduInstance? Pdu, Models.Config.PduConfig Cfg) ResolveInstance(string? requested)
    {
        var id = ResolveInstanceId(requested);
        return (id, registry.Get(id), config.Pdus.TryGetValue(id, out var c) ? c : new());
    }

    /// <summary>Gui.AuthType is None.</summary>
    private bool AuthDisabled => config.Gui.AuthType == GuiAuthType.None;

    /// <summary>OIDC is selected with authority and client id set.</summary>
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
        // Raise Kestrel's 32 KB header cap; cookies otherwise trigger 431.
        builder.WebHost.ConfigureKestrel(k => k.Limits.MaxRequestHeadersTotalSize = 64 * 1024);

        // Must precede auth wiring: the cookie handler captures the key ring at build time.
        ConfigureDataProtection(builder);

        if (UseOidc)
            ConfigureOidc(builder, gui.Oidc);

        app = builder.Build();

        if (UseOidc)
        {
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

    /// <summary>Persist the auth-cookie encryption key across restarts.</summary>
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

    /// <summary>Wire cookie + OpenID Connect authentication.</summary>
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
            o.ResponseMode = "query";
            o.UsePkce = true;
            o.CallbackPath = oidc.CallbackPath;
            o.SaveTokens = true;
            o.GetClaimsFromUserInfoEndpoint = true;
            o.Scope.Clear();
            foreach (var scope in (oidc.Scopes ?? "openid profile email").Split(' ', StringSplitOptions.RemoveEmptyEntries))
                o.Scope.Add(scope);

            // Some providers sign the id_token with HS256, whose key is not in JWKS.
            if (!string.IsNullOrEmpty(oidc.ClientSecret))
                o.TokenValidationParameters.IssuerSigningKey =
                    new Microsoft.IdentityModel.Tokens.SymmetricSecurityKey(Encoding.UTF8.GetBytes(oidc.ClientSecret));

            o.CorrelationCookie.SameSite = SameSiteMode.Lax;
            o.CorrelationCookie.SecurePolicy = CookieSecurePolicy.SameAsRequest;
            o.NonceCookie.SameSite = SameSiteMode.Lax;
            o.NonceCookie.SecurePolicy = CookieSecurePolicy.SameAsRequest;

            // Surface the real failure reason instead of a bare 500.
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

        builder.Services.AddAuthorizationBuilder()
            .SetFallbackPolicy(new AuthorizationPolicyBuilder().RequireAuthenticatedUser().Build());
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        // Stop pushing before shutdown so SSE connections end cleanly.
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

    /// <summary>The push hub, built on the first /api/events connection.</summary>
    private GuiEventHub EventHub()
    {
        lock (eventsGate)
            return events ??= new GuiEventHub(ConfigSchema.Json,
                new GuiEventHub.Feed("status", TimeSpan.FromSeconds(5), (_, ct) => BuildStatusAsync(null, ct)),
                new GuiEventHub.Feed("board", TimeSpan.FromSeconds(3), (_, _) => BuildBoardAsync()),
                // "livedata:<instance>"; bare "livedata" is the primary.
                new GuiEventHub.Feed("livedata", TimeSpan.FromSeconds(2), BuildLiveDataAsync),
                // "flow:<metric>" or "flow:<metric>|<instance>".
                new GuiEventHub.Feed("flow", TimeSpan.FromSeconds(2), (arg, ct) =>
                {
                    var parts = (arg ?? "").Split('|');
                    return BuildFlowAsync(parts.Length > 1 ? parts[1] : null, parts[0], ct);
                }));
    }

    /// <summary>Identifies this process, distinct from the build version.</summary>
    private static readonly string Instance = Guid.NewGuid().ToString("N")[..12];

    /// <summary>Header state: version, config, MQTT and operator update report.</summary>
    private async Task<object> BuildStatusAsync(string? user, CancellationToken ct) => new
    {
        version = Version,
        instance = Instance,
        configSource = configSource.Describe,
        configWritable = configSource.CanWrite,
        gitops = configSource.IsGitOpsManaged,
        mqttConnected = mqtt.IsConnected(),
        mqttHost = $"{mqtt.Options.Host}:{mqtt.Options.Port}",
        actionsEnabled = config.Primary.ActionsEnabled,
        auth = AuthDisabled ? "none" : UseOidc ? "oidc" : "basic",
        showProjectLink = config.Gui.ShowProjectLink,
        user,
        update = await ReadOperatorUpdateAsync(configSource as KubernetesConfigSource, ct),
        // Settings saved but waiting on a restart.
        restart = new { required = pending.Required, settings = pending.Settings },
    };

    /// <summary>Retained discovery configs under our prefix that this build would not publish today.</summary>
    private async Task<IReadOnlyList<string>> OrphanedDiscoveryAsync()
    {
        var prefix = config.HASS.DiscoveryTopic;
        if (string.IsNullOrWhiteSpace(prefix)) return Array.Empty<string>();

        var index = topicIndex;
        index.Renew(prefix.Trim().Trim('/') + "/#");
        var retained = (index.Search(null, 5000)).Select(t => t.Topic).ToList();

        // What the exporter would publish now: non-synthetic tiers not covered by native PDU discovery.
        var merged = new Models.PDU.PduData();
        foreach (var s in snapshots.All) merged.Devices.AddRange(s.Data.Devices);

        var energyMetric = string.IsNullOrWhiteSpace(config.HASS.EnergyDashboard.EnergyMeasurementType)
            ? "energy" : config.HASS.EnergyDashboard.EnergyMeasurementType;
        var graph = Core.Flow.FlowGraphBuilder.Build(merged, config.EnergyFlow, Core.Flow.FlowGraphBuilder.DefaultMetric, live);
        var native = Core.Flow.FlowExport.NativeEnergyUniqueIds(merged, energyMetric);

        var current = Core.Flow.FlowExport.ExportedDeviceIds(graph, config.EnergyFlow.MqttExportTags, native)
            .Concat(Core.Flow.LocationExport.DeviceIds(config.EnergyFlow)).ToList();

        var orphans = Core.Flow.FlowExport.OrphanedDiscoveryTopics(retained, current, prefix).ToList();

        // Include native PDU discovery too.
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
            // Evaluated on read so "ago" text is never stale.
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

    /// <summary>Current readings for one instance, flat and pivoted, plus OneView group rollups.</summary>
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

            // One row per outlet/entity, measurements as columns.
            var types = readingList.Select(r => r.Type).Distinct(StringComparer.OrdinalIgnoreCase).OrderBy(t => t).ToList();
            var units = readingList.GroupBy(r => r.Type, StringComparer.OrdinalIgnoreCase)
                .ToDictionary(g => g.Key, g => g.Select(r => r.Units).FirstOrDefault(u => !string.IsNullOrEmpty(u)) ?? "", StringComparer.OrdinalIgnoreCase);

            var entities = new List<object>();
            foreach (var device in data.Devices)
            {
                foreach (var o in device.Outlets.OrderBy(o => o.Key))
                    entities.Add(BuildLiveEntity(device.Entity_DisplayName, o.Entity_DisplayName, "outlet", o.Key + 1,
                        pdu?.ResolveOutletState(device.Key, o.Key, o.State) ?? o.State, o.Measurements));
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

    /// <summary>One value per node per day across a window.</summary>
    private async Task<object> BuildSeriesAsync(string? instance, string metric, IReadOnlyList<DateTime> when,
                                                IReadOnlyList<string>? labels, string? partialLabel, CancellationToken ct,
                                                int? requestedStepSeconds = null, IReadOnlyCollection<string>? only = null)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(TimeSpan.FromSeconds(60));
        try
        {
            if (!config.History.Enabled || history is null)
                return new { ok = false, message = "History is not enabled. Turn it on under Features and set a backend." };

            var (id, pdu, _) = ResolveInstance(instance);
            var data = await ResolveData(id, pdu, cts.Token);

            var shape = FlowGraphBuilder.Build(data, config.EnergyFlow, metric, live);
            var lanes = FlowLanes.For(shape.Nodes);
            // ?nodes=a,b limits the series to those nodes, for a caller that charts only a few.
            if (only is { Count: > 0 }) lanes = lanes.Where(l => only.Contains(l.Id, StringComparer.OrdinalIgnoreCase)).ToList();
            if (lanes.Count == 0) return new { ok = false, message = "No nodes to chart yet." };

            var perDay = await history.SeriesAsync(lanes.Select(l => l.Id).ToList(), metric, when, cts.Token);

            var drawn = lanes
                .Select(n => new
                {
                    node = n.Id,
                    label = n.Label,
                    kind = n.Kind,
                    tags = n.Tags,
                    values = perDay.Select(day => day.TryGetValue(n.Id, out var v) ? (double?)v : null).ToList(),
                })
                // Skip nodes with no data in the window.
                .Where(s => s.values.Any(v => v is not null))
                .ToList();

            // Nodes already held by another node, which a per-kind total would count twice.
            var topology = FlowTopology.For(data, config.EnergyFlow);
            // A return lane (…#in) is judged by its own node.
            static (string Id, string Suffix) Lane(string id) => id.EndsWith(FlowMetricKey.InSuffix, StringComparison.Ordinal)
                ? (id[..^FlowMetricKey.InSuffix.Length], FlowMetricKey.InSuffix) : (id, "");
            var ids = drawn.Select(s => Lane(s.node).Id).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
            // The total each counts toward; a return lane counts toward its node's.
            var balance = shape.Nodes.Where(n => !n.Synthetic)
                .ToDictionary(n => n.Id, n => n.Balance, StringComparer.OrdinalIgnoreCase);
            var series = drawn
                .Select(s =>
                {
                    var (baseId, suffix) = Lane(s.node);
                    var holder = CountOnce.CountedBy(config.EnergyFlow, baseId, ids, topology);
                    return new
                    {
                        s.node, s.label, s.kind, s.tags, s.values,
                        within = holder is null ? null : holder + suffix,
                        balance = balance.GetValueOrDefault(baseId),
                    };
                })
                .ToList();

            if (series.Count == 0)
                return new { ok = false, message = $"No history between {when[0]:u} and {when[^1]:u} from {history.Id}. The backend may not reach that far back, or may not hold this metric." };

            return new
            {
                ok = true,
                metric,
                units = FlowUnits.Canonical(metric),
                source = history.Id,
                // Day key the counters re-base on.
                days = labels,
                at = when.Select(w => DateTime.SpecifyKind(w, DateTimeKind.Utc)).ToList(),
                // The last bar is a period still in progress.
                partial = partialLabel,
                stepSeconds = when.Count > 1 ? (int)(when[1] - when[0]).TotalSeconds : 0,
                requestedStepSeconds,
                series,
            };
        }
        catch (Exception ex) { return new { ok = false, message = $"Could not build the series: {ex.Message}" }; }
    }

    private static readonly string[] ReadingMetrics = ["realpower", "apparentpower", "current", "voltage", "powerfactor", "frequency"];

    /// <summary>Each node's value for every metric, one graph per metric.</summary>
    private async Task<object> BuildReadingsAsync(string? instance, CancellationToken ct)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(TimeSpan.FromSeconds(20));
        try
        {
            var (id, pdu, _) = ResolveInstance(instance);
            var data = await ResolveData(id, pdu, cts.Token);
            var nodes = ReadingMetrics.Concat(FlowTiers.Metrics(config))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .Select(m => FlowGraphBuilder.Build(data, config.EnergyFlow, m, live))
                .SelectMany(g => g.Nodes
                    .Where(n => !n.Synthetic && n.Value is not null)
                    .Select(n => new { node = n.Id, metric = g.Metric, value = n.Value!.Value, units = g.Units, derivation = n.Derivation }))
                .GroupBy(x => x.node, StringComparer.OrdinalIgnoreCase)
                .Select(g => new { node = g.Key, readings = g.Select(x => new { x.metric, x.value, x.units, x.derivation }).ToArray() })
                .ToArray();
            return new { ok = true, nodes };
        }
        catch (Exception ex) { return new { ok = false, message = $"Could not read the node readings: {ex.Message}" }; }
    }

    /// <summary>The energy-flow graph for one instance + metric.</summary>
    private async Task<object> BuildFlowAsync(string? instance, string? metric, CancellationToken ct, DateTime? atUtc = null, int spanDays = 1)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(TimeSpan.FromSeconds(20));
        try
        {
            var (id, pdu, _) = ResolveInstance(instance);
            var data = await ResolveData(id, pdu, cts.Token);
            var m = string.IsNullOrEmpty(metric) ? FlowGraphBuilder.DefaultMetric : metric;

            // A past moment: the graph built from that instant's values.
            var values = live;
            if (atUtc is { } at)
            {
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

    // Constant-time comparison.
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

        // OIDC sign-out: clears the cookie and ends the IdP session.
        if (UseOidc)
            app.MapGet("/logout", async (HttpContext ctx) =>
            {
                await ctx.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme);
                await ctx.SignOutAsync(OpenIdConnectDefaults.AuthenticationScheme);
            });

        app.MapGet("/api/schema", () =>
        {
            // Settings schema for plugin config pages, generated by reflection.
            var schema = ConfigSchema.Build(pluginSections?.Sections ?? []);
            // Under Kubernetes, logging is driven by the platform.
            if (configSource is KubernetesConfigSource)
                schema = schema.Where(n => n.Key != "Logging").ToList();
            return Results.Json(schema, ConfigSchema.Json);
        });

        // Re-read the current source, which may have been edited.
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
                // Config this process is running, before replacement.
                var pageSettings = (integrations?.All ?? []).OfType<Core.Integrations.IGuiPageProvider>()
                    .SelectMany(p => p.PageSettings.Select(k => $"Plugins.{((Core.Integrations.IIntegration)p).Id}.{k}"));
                var stranded = ConfigApply.NeedingRestart(config, parsed, pageSettings);

                await configSource.SaveAsync(parsed, ctx.RequestAborted);
                Log.Information($"Configuration saved via GUI to {configSource.Describe}.");

                // Re-read the saved config so live-readable settings apply without a restart.
                var reloaded = configSource.Load();
                config.EnergyFlow = reloaded.EnergyFlow;
                config.HASS.EnergyDashboard = reloaded.HASS.EnergyDashboard;
                config.EmonCMS.Feeds = reloaded.EmonCMS.Feeds;
                config.History = reloaded.History;
                config.PlanStorage = reloaded.PlanStorage;
                config.Gui.DistanceUnits = reloaded.Gui.DistanceUnits;

                // Apply PDU instance add/remove live.
                var instanceMessage = "";
                try
                {
                    config.Pdus = reloaded.Pdus;
                    await registry.ReconcileAsync();
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
                    restartRequired = stranded.Count > 0,
                    restartSettings = stranded,
                }, ConfigSchema.Json);
            }
            catch (Exception ex)
            {
                var explained = Startup.ConfigSources.KubernetesSaveError.Explain(ex);
                return Results.Json(new { ok = false, message = explained ?? $"Failed to save config: {ex.Message}" }, statusCode: 500);
            }
        });

        // Export the current config as an RpduConfig CR manifest, secrets redacted.
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

        app.MapGet("/api/status", async (HttpContext ctx) =>
        {
            return Results.Json(await BuildStatusAsync(UseOidc ? ctx.User?.Identity?.Name : null, ctx.RequestAborted), ConfigSchema.Json);
        });

        // Single SSE push channel for the whole GUI.
        app.MapGet("/api/events", (HttpContext ctx) => EventHub().StreamAsync(ctx, ctx.Request.Query["topics"].ToString()));

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

        // Tags available for the deployed image.
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
                // Existing moving channels first, then release versions newest-first.
                var channels = new[] { "stable", "latest", "edge", "dev", "unstable" }.Where(tags.Contains).ToArray();
                var versions = tags.Where(t => Updates.SemVer.TryParse(t, out _))
                    .Select(t => { Updates.SemVer.TryParse(t, out var v); return (Tag: t, Ver: v!); })
                    .Where(x => !x.Ver.IsPreRelease)
                    .OrderByDescending(x => x.Ver).Select(x => x.Tag).Take(50).ToArray();
                return Results.Json(new { ok = true, current = image.Tag, registry = image.Registry, repository = image.Repository, channels, versions }, ConfigSchema.Json);
            }
            catch (Exception ex) { return Results.Json(new { ok = false, message = $"Could not list tags: {ex.Message}" }, ConfigSchema.Json); }
        });

        // Switch the deployed image tag.
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

        // Force update: re-pull the currently-deployed tag.
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

        // Configured PDU instances.
        app.MapGet("/api/instances", () =>
        {
            var primaryId = ResolveInstanceId(null);
            // Only pollable instances.
            var instances = registry.All.Keys.Select(id => new
            {
                id,
                primary = string.Equals(id, primaryId, StringComparison.OrdinalIgnoreCase),
                actionsEnabled = config.Pdus.TryGetValue(id, out var c) && c.ActionsEnabled,
            }).ToList();
            return Results.Json(new { ok = true, instances }, ConfigSchema.Json);
        });

        // Server time and the next energy-day rollover.
        app.MapGet("/api/time", () =>
        {
            var agg = config.EnergyFlow.Aggregation;
            var now = DateTime.UtcNow;
            var configured = agg.PeriodTimeZone;
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
                    // Whether today's figures cover the whole day.
                    carriedOver = (live as Core.Flow.IPeriodTotalsOrigin)?.CarriedOverNodes ?? 0,
                    accumulatingSinceUtc = (live as Core.Flow.IPeriodTotalsOrigin)?.AccumulatingSinceUtc,
                    store = (live as Core.Flow.IPeriodTotalsOrigin)?.StoreKind,
                },
            }, ConfigSchema.Json);
        });

        // Energy-flow device templates the Nodes tab can import.
        app.MapGet("/api/node-templates", () =>
            Results.Json(new { ok = true, templates = rPDU2MQTT.NodeTemplates.NodeTemplateCatalog.All }, ConfigSchema.Json));

        // The Status board: every hop's card.
        app.MapGet("/api/status/board", async () => Results.Json(await BuildBoardAsync(), ConfigSchema.Json));

        // Diagnostics: versions, uptime, runtime, Kubernetes context.
        app.MapGet("/api/diagnostics", async (HttpContext ctx) =>
        {
            var k8s = configSource as KubernetesConfigSource;

            var update = await ReadOperatorUpdateAsync(k8s, ctx.RequestAborted);

            // Process list from the registry.
            var processList = processes?.Active() ?? [];

            // Panel-mapping and live-reading contradictions.
            var panelFindings = Core.Flow.PanelAudit.Check(config.EnergyFlow, live,
                config.EnergyFlow.Nodes.Where(n => !string.IsNullOrWhiteSpace(n.Id)).Select(n => n.Id))
                .Select(f => new { kind = f.Kind, severity = f.Severity, message = f.Message, breakers = f.Breakers, channels = f.Channels })
                .ToArray();

            var reported = Core.Diagnostics.IntegrationReports.Local(integrationStatus);
            var integrationList = (integrations?.All ?? [])
                .Where(i => i is Core.Integrations.IMeasurementDestination or Core.Integrations.IConfigurationPublisher
                                 or Core.Integrations.IDeviceSourcePlugin)
                .Where(i => i.Enabled(config))
                .Select(i => new
                {
                    id = i.Id,
                    name = i.DisplayName,
                    status = reported.TryGetValue(i.Id, out var mine) ? mine : Core.Diagnostics.IntegrationReports.Freshest(processList, i.Id),
                })
                .ToArray();

            // Modbus source health per configured connection.
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
                // Workloads this process runs.
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
                // Panel-mapping contradictions.
                panelFindings,
                // Other role processes in a split deployment.
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
                integrations = integrationList,
            }, ConfigSchema.Json);
        });

        // Each configured node's rolled-up value, per metric.
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

        // Every reading per node, for the diagram's hover card.
        app.MapGet("/api/flow/readings", async (HttpContext ctx) =>
        {
            return Results.Json(await BuildReadingsAsync(ctx.Request.Query["instance"], ctx.RequestAborted), ConfigSchema.Json);
        });

        // Resolved panel directory: each breaker's chain to its measuring channel, and its power.
        object PanelsPayload(Models.Config.EnergyFlowConfig flow, string metric)
        {
            var map = Core.Flow.PanelMap.For(flow);
            // Every node the bridge reads, to name unclaimed channels.
            var channels = flow.Nodes.Where(n => !string.IsNullOrWhiteSpace(n.Id)).Select(n => n.Id).ToList();
            var findings = Core.Flow.PanelAudit.Check(flow, live, channels, metric);
            var nodes = Core.Flow.PanelNodes.For(flow).ToDictionary(b => Core.Flow.Circuits.RefOf(b.Chain), b => b, StringComparer.OrdinalIgnoreCase);
            var panels = flow.Panels.Select(panel => new
            {
                id = panel.Id,
                name = panel.Name,
                slots = panel.Slots,
                rows = panel.Rows,
                node = panel.Node,
                // Panel draw; null is a gap, not a zero.
                incoming = !string.IsNullOrWhiteSpace(panel.Node) && live is not null
                    && live.TryGetValue(panel.Node, metric, out var incoming) ? incoming : (double?)null,
                // Mains voltage, when reported.
                volts = !string.IsNullOrWhiteSpace(panel.Node) && live is not null
                    && live.TryGetValue(panel.Node, "voltage", out var volts) ? volts : (double?)null,
                breakers = map.Chains.Where(c => ReferenceEquals(c.Panel, panel)).Select(chain =>
                {
                    var power = Core.Flow.PanelMap.Power(chain, live, metric, out var gap);
                    return new
                    {
                        slot = chain.Breaker.Slot,
                        occupies = chain.Breaker.Occupies().ToArray(),
                        number = chain.Breaker.Number,
                        poles = chain.Breaker.Poles,
                        half = chain.Breaker.Half,
                        amps = chain.Breaker.Amps,
                        wire = chain.Breaker.Wire,
                        gauge = chain.Breaker.Gauge,
                        conductor = chain.Breaker.Conductor,
                        description = chain.Breaker.Description,
                        state = Models.Config.BreakerState.Of(chain.Breaker.State),
                        // Breaker as a flow tier: its own node or the one it names.
                        node = nodes.TryGetValue(Core.Flow.Circuits.RefOf(chain), out var bn) ? bn.Id : null,
                        derived = nodes.TryGetValue(Core.Flow.Circuits.RefOf(chain), out var dn) && dn.Derived,
                        // Null power is a gap; `gap` names the missing link.
                        power,
                        // Measured amps, never inferred from watts.
                        current = Core.Flow.PanelMap.Power(chain, live, "current"),
                        gap = gap.ToString().ToLowerInvariant(),
                        legs = chain.Legs.Select(l => new
                        {
                            leg = l.Leg,
                            wire = l.Wire,
                            clamp = l.Clamp?.Label,
                            amps = l.Clamp?.Amps,
                            reversed = l.Clamp?.Reversed ?? false,
                            channel = l.Channel,
                        }).ToArray(),
                    };
                }).ToArray(),
            }).ToArray();
            return new
            {
                ok = true, metric, panels,
                findings = findings.Select(f => new { kind = f.Kind, severity = f.Severity, message = f.Message, breakers = f.Breakers, channels = f.Channels }).ToArray(),
            };
        }

        string PanelMetric(HttpContext ctx) => string.IsNullOrWhiteSpace(ctx.Request.Query["metric"])
            ? Core.Flow.FlowGraphBuilder.DefaultMetric : ctx.Request.Query["metric"].ToString();

        app.MapGet("/api/panels", (HttpContext ctx) =>
        {
            try { return Results.Json(PanelsPayload(config.EnergyFlow, PanelMetric(ctx)), ConfigSchema.Json); }
            catch (Exception ex) { return Results.Json(new { ok = false, message = ex.Message }, ConfigSchema.Json); }
        });

        // Same, for an unsaved directory.
        app.MapPost("/api/panels/resolve", async (HttpContext ctx) =>
        {
            try
            {
                using var reader = new StreamReader(ctx.Request.Body);
                var json = await reader.ReadToEndAsync(ctx.RequestAborted);
                var posted = string.IsNullOrWhiteSpace(json) ? config : ConfigSchema.FromJson(json);
                return Results.Json(PanelsPayload(posted.EnergyFlow ?? config.EnergyFlow, PanelMetric(ctx)), ConfigSchema.Json);
            }
            catch (Exception ex) { return Results.Json(new { ok = false, message = ex.Message }, ConfigSchema.Json); }
        });

        MapLocationEndpoints(app);
        MapCircuitFinderEndpoints(app);

        // Parse a pasted panel directory for preview; writes nothing.
        app.MapPost("/api/panels/import", async (HttpContext ctx) =>
        {
            try
            {
                var body = await System.Text.Json.JsonDocument.ParseAsync(ctx.Request.Body, cancellationToken: ctx.RequestAborted);
                var text = body.RootElement.TryGetProperty("text", out var t) ? t.GetString() ?? "" : "";
                var panelId = body.RootElement.TryGetProperty("panel", out var pid) ? pid.GetString() ?? "" : "";
                var flow = body.RootElement.TryGetProperty("config", out var c)
                    ? ConfigSchema.FromJson(c.GetRawText()).EnergyFlow ?? config.EnergyFlow
                    : config.EnergyFlow;
                var panel = flow.Panels.FirstOrDefault(p => string.Equals(p.Id, panelId, StringComparison.OrdinalIgnoreCase)) ?? new Models.Config.PanelConfig();
                var known = new HashSet<string>(flow.Nodes.Select(n => n.Id).Where(x => !string.IsNullOrWhiteSpace(x)), StringComparer.OrdinalIgnoreCase);
                var rows = Core.Flow.PanelDirectoryImport.Parse(text).Select(r => new
                {
                    line = r.Line, number = r.Number, slot = r.Slot, poles = r.Poles, half = r.Half, wire = r.Wire,
                    amps = r.Amps, channel = r.Channel, description = r.Description, state = r.State, note = r.Note,
                    effect = Core.Flow.PanelDirectoryImport.Effect(panel, r),
                    // Unknown channels are kept and flagged.
                    channelKnown = r.Channel.Length == 0 || known.Contains(r.Channel),
                }).ToArray();
                return Results.Json(new { ok = true, rows }, ConfigSchema.Json);
            }
            catch (Exception ex) { return Results.Json(new { ok = false, message = ex.Message }, ConfigSchema.Json); }
        });

        // Restart a tier, or everything.
        app.MapPost("/api/restart", async (HttpContext ctx) =>
        {
            var target = (ctx.Request.Query["target"].FirstOrDefault() ?? "local").Trim().ToLowerInvariant();

            if (target is "" or "local")
            {
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

            // Non-Kubernetes: restart matching processes over the bus.
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

        // Restartable targets, for the Diagnostics page buttons.
        app.MapGet("/api/restart/targets", async (HttpContext ctx) =>
        {
            if (configSource is KubernetesConfigSource kube)
            {
                var targets = new List<object> { new { id = "all", label = "Everything" } };
                try
                {
                    // Only split-deployment tiers get their own button.
                    foreach (var d in (await AppDeploymentsAsync(kube, ctx.RequestAborted)).OrderBy(d => d.Metadata?.Name))
                    {
                        var comp = ComponentOf(d);
                        if (!string.IsNullOrEmpty(comp)) targets.Add(new { id = comp, label = $"{comp} ({d.Metadata?.Name})" });
                    }
                }
                catch { /* fall back to just "Everything" */ }
                return Results.Json(new { ok = true, method = "rollout", targets }, ConfigSchema.Json);
            }

            // Non-Kubernetes: roles seen in the cluster, else this process.
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

        // Tail of this pod's container logs (Kubernetes only).
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

        // Recent Kubernetes events for this pod.
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

        // Browse the broker, for topic autocomplete.
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
                var stale = await haEnergy.StaleDevicesAsync();

                // Optional id list for batching.
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

        // Retained HA discovery configs this build would no longer publish; POST removes them.
        async Task<IReadOnlyList<Core.Discovery.TopicSample>> ScanAsync(string filter, CancellationToken ct)
        {
            var index = topicIndex;
            return await Core.Flow.TopicIndexScan.SettleAsync<Core.Discovery.TopicSample>(
                // Adapt the synchronous index to the helper's async shape.
                renew: () => { index.Renew(filter); return Task.CompletedTask; },
                search: () => Task.FromResult<IReadOnlyList<Core.Discovery.TopicSample>>(index.Search(null, 5000)),
                delay: d => Task.Delay(d, ct),
                pollEvery: TimeSpan.FromMilliseconds(750),
                deadline: DateTime.UtcNow.AddSeconds(12),
                now: () => DateTime.UtcNow,
                ct: ct);
        }

        // Power/energy readings other integrations announce via HA MQTT discovery.
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

        // Readings matched by topic shape, for publishers without HA discovery.
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
                    tags = profile.Tags ?? [],
                    readings = matches.Select(m => new
                    {
                        id = Core.Flow.MqttDiscoveryImport.NodeId($"{profile.Id}_{m.Device}_{m.Measure}"),
                        label = $"{m.Device} {m.Measure}",
                        device = m.Device,
                        topic = m.Topic, metric = m.Metric, unit = (string?)null,
                        units = Core.Flow.FlowUnits.UnitsFor(m.Metric ?? ""),
                        canonicalUnit = Core.Flow.FlowUnits.Canonical(m.Metric ?? ""),
                        jsonField = m.JsonField, sample = m.Sample, unsupported = (string?)null,
                        accumulation = m.Accumulation,
                    }),
                }, ConfigSchema.Json);
            }
            catch (Exception ex) { return Results.Json(new { ok = false, message = ex.Message }, ConfigSchema.Json); }
        });

        // One profile's full definition, for copying into MQTT.ImportProfiles.
        app.MapGet("/api/mqtt/profile", (HttpContext ctx) =>
        {
            var p = Core.Flow.MqttTopicProfile.Resolve(ctx.Request.Query["id"].ToString(), config.MQTT.ImportProfiles);
            if (p is null) return Results.Json(new { ok = false, message = "Unknown topic profile." }, ConfigSchema.Json);
            return Results.Json(new
            {
                ok = true,
                profile = new { id = p.Id, label = p.Label, filter = p.Filter, pattern = p.Pattern, jsonField = p.JsonField, metrics = p.Metrics, tags = p.Tags ?? [] },
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
                // An empty retained payload deletes a retained message.
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
                // Browse filter, default '#'.
                var filter = ctx.Request.Query["filter"].FirstOrDefault();
                var state = index.Renew(filter);
                var q = ctx.Request.Query["q"].FirstOrDefault();
                var limit = int.TryParse(ctx.Request.Query["limit"].FirstOrDefault(), out var n) ? n : 50;

                // The explorer asks for everything once, then only what changed after its cursor.
                if (long.TryParse(ctx.Request.Query["since"].FirstOrDefault(), out var since))
                {
                    var changes = index.Changes(since, ctx.Request.Query["epoch"].FirstOrDefault());
                    var st = changes.State;
                    return Results.Json(new
                    {
                        ok = true, listening = st.Listening, indexed = st.Topics, capacity = st.Capacity, filter = st.Filter, granted = st.Granted,
                        cursor = changes.Cursor, epoch = changes.Epoch, reset = changes.Reset,
                        topics = changes.Topics.Select(Describe).ToArray(),
                    }, ConfigSchema.Json);
                }

                var topics = (index.Search(q, limit)).Select(Describe).ToArray();

                return Results.Json(new { ok = true, listening = state.Listening, indexed = state.Topics, capacity = state.Capacity, filter = state.Filter, granted = state.Granted, topics }, ConfigSchema.Json);

                static object Describe(Core.Discovery.TopicSample t)
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
                }
            }
            catch (Exception ex) { return Results.Json(new { ok = false, message = ex.Message }, ConfigSchema.Json); }
        });

        // One topic's last payload and the metric/unit it implies.
        app.MapGet("/api/mqtt/topic", async (HttpContext ctx) =>
        {
            try
            {
                var topic = ctx.Request.Query["topic"].FirstOrDefault() ?? "";
                var index = topicIndex;
                index.Renew(null);   // keep the current browse filter alive
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

        // Read a block of registers off a Modbus device.
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

                // Each register as uint16/int16, and each pair as float32/int32.
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

                // Fold the four decodings of each register into one row.
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

        // Probe a Modbus TCP device: connect and optionally read register specs.
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

        // Current live value per (node, metric).
        app.MapPost("/api/flow/live", async (HttpContext ctx) =>
        {
            try
            {
                var reqs = await System.Text.Json.JsonSerializer.DeserializeAsync<List<LiveValueQuery>>(
                    ctx.Request.Body, ProbeJson, ctx.RequestAborted) ?? new();

                // ?at=<ISO-8601> answers from history.
                if (DateTime.TryParse(ctx.Request.Query["at"].ToString(), null,
                        System.Globalization.DateTimeStyles.AdjustToUniversal | System.Globalization.DateTimeStyles.AssumeUniversal, out var at))
                {
                    if (!config.History.Enabled || history is null)
                        return Results.Json(new { ok = false, message = "History is not enabled. Turn it on under Features and set a backend." }, ConfigSchema.Json);
                    var past = new List<object>();
                    foreach (var group in reqs.Where(q => !string.IsNullOrEmpty(q.Node) && !string.IsNullOrEmpty(q.Metric))
                                 .GroupBy(q => q.Metric!, StringComparer.OrdinalIgnoreCase))
                    {
                        var ids = group.Select(q => q.Node!).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
                        var found = await history.ValuesAtAsync(ids, group.Key, at, ctx.RequestAborted);
                        past.AddRange(ids.Select(node => (object)new
                        {
                            node, metric = group.Key,
                            value = found.TryGetValue(node, out var v) ? (double?)v : null,
                        }));
                    }
                    return Results.Json(new { ok = true, historical = true, at, source = history.Id, values = past }, ConfigSchema.Json);
                }

                // `value` is the reading only if still trustworthy.
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

        // Does the history backend answer?
        // Data directories this process writes to, and free space on each.
        app.MapGet("/api/diagnostics/storage", (HttpContext ctx) =>
        {
            var entries = Core.StorageUsage.Locations(config, localHistory?.Root, global::rPDU2MQTT.Plugins.PluginLoader.DefaultDirectory);

            return Results.Json(new
            {
                ok = true,
                entries = entries.Select(e => new
                {
                    e.Name, e.Path, e.Exists, e.Writable, e.Bytes, e.Files, e.Mount, e.TotalBytes, e.FreeBytes,
                    // Same verdict as the Status card.
                    state = Core.StorageUsage.StateOf(e).ToString(),
                    // Volume fullness alone, for colouring the Used column.
                    room = Core.StorageUsage.Room(e.FreeBytes, e.TotalBytes).ToString(),
                }).ToList(),
            }, ConfigSchema.Json);
        });

        // Where readings are actually written, resolving an empty LocalPath.
        app.MapGet("/api/history/store", (HttpContext ctx) =>
        {
            if (localHistory is null) return Results.Json(new { ok = false, message = "No local history store in this process." }, ConfigSchema.Json);
            var root = localHistory.Root;
            long bytes = 0;
            var series = 0;
            try
            {
                series = localHistory.Folders().Count;
                bytes = Directory.Exists(root)
                    ? new DirectoryInfo(root).EnumerateFiles("*.rts", SearchOption.AllDirectories).Sum(f => f.Length)
                    : 0;
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            return Results.Json(new
            {
                ok = true,
                path = root,
                fromEnvironment = string.IsNullOrWhiteSpace(config.History.LocalPath),
                recording = config.History.LocalEnabled,
                series,
                bytes,
                tiers = localHistory.Tiers.Select(t => new { t.Name, t.IntervalSeconds, t.KeepDays }).ToList(),
                oldest = localHistory.Oldest(),
            }, ConfigSchema.Json);
        });

        // Copying history between backends: capabilities, progress, and start.
        app.MapGet("/api/history/copy", () => historyCopy is null
            ? Results.Json(new { ok = false, message = "History copying is not available in this process." }, ConfigSchema.Json)
            : Results.Json(new { ok = true, backends = historyCopy.Backends(), status = historyCopy.Status() }, ConfigSchema.Json));

        app.MapPost("/api/history/copy", (HttpContext ctx) =>
        {
            if (historyCopy is null) return Results.Json(new { ok = false, message = "History copying is not available in this process." }, ConfigSchema.Json);
            var q = ctx.Request.Query;
            var days = int.TryParse(q["days"], out var d) ? d : 0;
            var replace = string.Equals(q["conflicts"], "replace", StringComparison.OrdinalIgnoreCase);
            return Results.Json(historyCopy.Start(q["from"].ToString(), q["to"].ToString(), days, replace), ConfigSchema.Json);
        });

        app.MapPost("/api/test/history", async (HttpContext ctx) =>
        {
            if (!config.History.Enabled)
                return Results.Json(new { ok = false, message = "History is turned off. Enable it under Features." }, ConfigSchema.Json);
            if (history is null)
                return Results.Json(new { ok = false, message = "No history backend is wired in this process." }, ConfigSchema.Json);
            try
            {
                // Probes the integration selected by the History setting.
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

        // Push the hierarchy into HA's Energy Dashboard, or clear it.
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

        // Integrations: one route shape for built-in and plugin integrations.

        // Nodes offered for adoption by every provider; discovery only.
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
                    // One failing provider must not empty the picker.
                    Log.Debug($"Node discovery from {provider.GetType().Name} failed: {ex.Message}");
                }
            }
            return Results.Json(new { ok = true, nodes = found }, ConfigSchema.Json);
        });

        app.MapGet("/api/plugins", () => Results.Json(pluginCatalog?.Plugins ?? [], ConfigSchema.Json));

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
                pages = i is Core.Integrations.IGuiPageProvider p && i.Enabled(config)
                    ? p.Pages.Select(g => new { id = g.Id, title = g.Title, group = g.Group, icon = g.Icon, configSection = g.ConfigSection })
                    : null,
                managedNodes = i is Core.Integrations.INodeManager m && i.Enabled(config)
                    ? m.ManagedNodes.Select(r => new { sourceType = r.SourceType, tag = r.Tag })
                    : null,
            });
            return Results.Json(new { ok = true, integrations = list }, ConfigSchema.Json);
        });

        // Serves a plugin page's script and stylesheet.
        app.MapGet("/api/integrations/{id}/pages/{file}", (string id, string file) =>
        {
            if (integrations?.ById(id) is not Core.Integrations.IGuiPageProvider provider
                || !provider.Pages.Any(g => file == g.Id + ".js" || file == g.Id + ".css"))
                return Results.NotFound();
            var text = provider.PageAsset(file);
            if (text is null) return file.EndsWith(".css", StringComparison.Ordinal) ? Results.Content("", "text/css") : Results.NotFound();
            return Results.Content(text, file.EndsWith(".css", StringComparison.Ordinal) ? "text/css" : "text/javascript");
        });

        app.MapPost("/api/integrations/{id}/{action}", async (string id, string action, HttpContext ctx) =>
        {
            if (integrations is null) return Results.Json(new { ok = false, message = "No integration registry in this process." }, ConfigSchema.Json);

            var integration = integrations.ById(id);
            if (integration is null) return Results.Json(new { ok = false, message = $"No integration called '{id}'." }, ConfigSchema.Json);

            var found = Core.Integrations.IntegrationActions.Find(integration, action, CurrentPass);
            if (found is null) return Results.Json(new { ok = false, message = $"'{integration.DisplayName}' has no action called '{action}'." }, ConfigSchema.Json);

            // Query string and form fields, flattened.
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

        // Live discovered structure for the Overrides editor.
        app.MapGet("/api/live", async (HttpContext ctx) =>
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ctx.RequestAborted);
            cts.CancelAfter(TimeSpan.FromSeconds(20));
            try
            {
                var (id, pdu, _) = ResolveInstance(ctx.Request.Query["instance"]);
                var data = await ResolveData(id, pdu, cts.Token);

                // Raw PDU label plus discovered display name and object_id.
                var devices = data.Devices.Select(d => new
                {
                    key = d.Key,
                    label = d.Label,
                    name = d.Name,
                    displayName = d.Entity_DisplayName,
                    objectId = d.Entity_Name,
                    outlets = d.Outlets.OrderBy(o => o.Key).Select(o => new
                    {
                        // 1-based, matching outlet override keys (Outlets.<n>).
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

        // Live readings for the Live Data view.
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

        // Energy-flow graph for the Flow tab.
        app.MapGet("/api/flow", async (HttpContext ctx) =>
        {
            // ?at=<ISO-8601> renders that moment.
            DateTime? at = DateTime.TryParse(ctx.Request.Query["at"].ToString(), null,
                System.Globalization.DateTimeStyles.AdjustToUniversal | System.Globalization.DateTimeStyles.AssumeUniversal, out var parsed)
                ? parsed : null;
            // ?span=<days> sums that many daily totals, ending at ?at.
            var span = int.TryParse(ctx.Request.Query["span"].ToString(), out var d) ? Math.Clamp(d, 1, 366) : 1;
            return Results.Json(await BuildFlowAsync(ctx.Request.Query["instance"], ctx.Request.Query["metric"].ToString(), ctx.RequestAborted, at, span), ConfigSchema.Json);
        });

        // One value per node per day over a window, for the Trends page.
        app.MapGet("/api/flow/series", async (HttpContext ctx) =>
        {
            var only = ctx.Request.Query["nodes"].ToString().Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            DateTime end = DateTime.TryParse(ctx.Request.Query["at"].ToString(), null,
                System.Globalization.DateTimeStyles.AdjustToUniversal | System.Globalization.DateTimeStyles.AssumeUniversal, out var parsed)
                ? parsed : DateTime.UtcNow;

            // A timeline selection: two instants at a fitting step.
            DateTime? Instant(string key) => DateTime.TryParse(ctx.Request.Query[key].ToString(), null,
                System.Globalization.DateTimeStyles.AdjustToUniversal | System.Globalization.DateTimeStyles.AssumeUniversal, out var instant)
                ? instant : null;
            if (SeriesWindow.Between(Instant("from"), Instant("to")) is { } picked)
            {
                var stepPicked = SeriesWindow.ClampStep(int.TryParse(ctx.Request.Query["step"].ToString(), out var sp) ? sp : null, 300);
                var metricPicked = string.IsNullOrWhiteSpace(ctx.Request.Query["metric"]) ? FlowGraphBuilder.DefaultMetric : ctx.Request.Query["metric"].ToString();
                return Results.Json(await BuildSeriesAsync(ctx.Request.Query["instance"], metricPicked,
                    SeriesWindow.Instants(picked.From, picked.To, stepPicked), null, null, ctx.RequestAborted, stepPicked, only), ConfigSchema.Json);
            }

            if (ctx.Request.Query["today"] == "1")
            {
                var dayZone = EnergyPeriod.Resolve(config.EnergyFlow.Aggregation.PeriodTimeZone);
                // ?back=<n> charts an earlier period; yesterday is back=1.
                var back = int.TryParse(ctx.Request.Query["back"].ToString(), out var bk) ? Math.Clamp(bk, 0, 366) : 0;
                (var began, end) = EnergyPeriod.Window(end, dayZone, config.EnergyFlow.Aggregation.PeriodStartHour, back);
                var stepToday = SeriesWindow.ClampStep(int.TryParse(ctx.Request.Query["step"].ToString(), out var ts) ? ts : null, 300);
                var metricToday = string.IsNullOrWhiteSpace(ctx.Request.Query["metric"]) ? FlowGraphBuilder.DefaultMetric : ctx.Request.Query["metric"].ToString();
                return Results.Json(await BuildSeriesAsync(ctx.Request.Query["instance"], metricToday,
                    SeriesWindow.Instants(began, end, stepToday), null, null, ctx.RequestAborted, stepToday, only), ConfigSchema.Json);
            }

            if (int.TryParse(ctx.Request.Query["minutes"].ToString(), out var mins))
            {
                var step = SeriesWindow.ClampStep(int.TryParse(ctx.Request.Query["step"].ToString(), out var st) ? st : null, 300);
                var span = TimeSpan.FromMinutes(Math.Clamp(mins, 5, SeriesWindow.MaxMinutes));
                var metricNow = string.IsNullOrWhiteSpace(ctx.Request.Query["metric"]) ? FlowGraphBuilder.DefaultMetric : ctx.Request.Query["metric"].ToString();
                return Results.Json(await BuildSeriesAsync(ctx.Request.Query["instance"], metricNow,
                    SeriesWindow.Instants(end - span, end, step), null, null, ctx.RequestAborted, step, only), ConfigSchema.Json);
            }

            // Up to a year.
            var days = int.TryParse(ctx.Request.Query["days"].ToString(), out var d) ? Math.Clamp(d, 2, 366) : 30;
            var metric = string.IsNullOrWhiteSpace(ctx.Request.Query["metric"]) ? FlowSpan.SpannableMetric : ctx.Request.Query["metric"].ToString();

            var zone = EnergyPeriod.Resolve(config.EnergyFlow.Aggregation.PeriodTimeZone);

            // A step samples within days instead of one total per day.
            if (int.TryParse(ctx.Request.Query["step"].ToString(), out var sd))
            {
                var stepDays = SeriesWindow.ClampStep(sd, 3600);
                var (from, _) = EnergyPeriod.Window(end, zone, config.EnergyFlow.Aggregation.PeriodStartHour, days - 1);
                return Results.Json(await BuildSeriesAsync(ctx.Request.Query["instance"], metric,
                    SeriesWindow.Instants(from, end, stepDays), null, null, ctx.RequestAborted, stepDays, only), ConfigSchema.Json);
            }

            // Each day read at its own rollover.
            var periods = EnergyPeriod.RecentPeriodEnds(end, zone, config.EnergyFlow.Aggregation.PeriodStartHour, days);
            return Results.Json(await BuildSeriesAsync(ctx.Request.Query["instance"], metric,
                periods.Select(p => p.AtUtc).ToList(), periods.Select(p => p.Day).ToList(),
                periods[^1].Complete ? null : periods[^1].Day, ctx.RequestAborted, null, only), ConfigSchema.Json);
        });

        // Exported history metrics with units.
        app.MapGet("/api/flow/metrics", () => Results.Json(new
        {
            ok = true,
            metrics = FlowTiers.Metrics(config)
                .Select(m => new { metric = m, units = FlowUnits.Canonical(m), epoch = FlowUnits.Epoch(m) }),
        }, ConfigSchema.Json));

        // Relations a calculated binding can use.
        app.MapGet("/api/flow/derivations", () => Results.Json(new
        {
            ok = true,
            metrics = DerivedMetrics.Derivable.Select(m => new
            {
                metric = m,
                name = DerivedMetrics.Name(m),
                units = FlowUnits.Canonical(m),
                from = DerivedMetrics.PairsFor(m).Select(p => new { a = p.A, b = p.B, label = p.Label, assumes = p.Assumes }),
            }),
        }, ConfigSchema.Json));

        // Readings the bridge drops, and why.
        app.MapGet("/api/flow/withheld", (HttpContext ctx) =>
        {
            var withheld = (live as Core.Flow.IWithheldSources)?.Withheld ?? Array.Empty<Core.Flow.WithheldSource>();
            return Results.Json(new
            {
                ok = true,
                sources = withheld.Select(w => new { node = w.Node, source = w.Source, metric = w.Metric, reason = w.Reason, integration = w.Integration }),
            }, ConfigSchema.Json);
        });

        // Preview the generated paths with the posted (unsaved) config.
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
                if (registry.Preview(parsed) is not { } preview)
                    return Results.Json(new { ok = false, message = NoPdu }, ConfigSchema.Json);
                var data = await preview.ReadAsync(cts.Token);
                return Results.Json(BuildPaths(data, parsed), ConfigSchema.Json);
            }
            catch (Exception ex)
            {
                return Results.Json(new { ok = false, message = $"Could not compute paths: {ex.Message}" }, ConfigSchema.Json);
            }
        });

        // Outlets available for control, with current state.
        app.MapGet("/api/control/outlets", async (HttpContext ctx) =>
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ctx.RequestAborted);
            cts.CancelAfter(TimeSpan.FromSeconds(20));
            try
            {
                var (id, pdu, instanceCfg) = ResolveInstance(ctx.Request.Query["instance"]);
                if (pdu is null) return Results.Json(new { ok = false, message = NoPdu }, ConfigSchema.Json);
                var data = await ResolveData(id, pdu, cts.Token);
                var outlets = data.Devices.SelectMany(d => d.Outlets.OrderBy(o => o.Key).Select(o => new
                {
                    deviceId = d.Key,
                    device = d.Entity_DisplayName,
                    index = o.Key,        // raw key the control API expects
                    number = o.Key + 1,   // 1-based, matching the PDU UI
                    name = o.Entity_DisplayName,
                    // Resolve through the pending-write latch so a just-set value shows.
                    label = pdu.ResolveOutletConfig(d.Key, o.Key, "label", o.Label ?? ""),
                    state = pdu.ResolveOutletState(d.Key, o.Key, o.State),
                    onDelay = pdu.ResolveOutletConfig(d.Key, o.Key, "onDelay", o.OnDelay.ToString()),
                    offDelay = pdu.ResolveOutletConfig(d.Key, o.Key, "offDelay", o.OffDelay.ToString()),
                    rebootDelay = pdu.ResolveOutletConfig(d.Key, o.Key, "rebootDelay", o.RebootDelay.ToString()),
                    poaAction = pdu.ResolveOutletConfig(d.Key, o.Key, "poaAction", o.PoaAction ?? ""),
                })).ToList();
                // Member-outlet lookup (deviceId, index) for per-member state.
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
                // PDUs and their circuits, with editable labels.
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

        // Control every outlet in a OneView group. Gated by ActionsEnabled.
        app.MapPost("/api/control/group", async (HttpContext ctx) =>
        {
            GroupControlRequest? req;
            try { req = await ctx.Request.ReadFromJsonAsync<GroupControlRequest>(ctx.RequestAborted); }
            catch { req = null; }
            if (req is null || string.IsNullOrWhiteSpace(req.GroupKey))
                return Results.BadRequest(new { ok = false, message = "groupKey and action are required." });

            var (_, pdu, instanceCfg) = ResolveInstance(req.Instance);
            if (pdu is null)
                return Results.Json(new { ok = false, message = NoPdu }, statusCode: 404);
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

        // Outlet control action (on/off/reboot). Gated by PDU.ActionsEnabled.
        app.MapPost("/api/control/outlet", async (HttpContext ctx) =>
        {
            ControlRequest? req;
            try { req = await ctx.Request.ReadFromJsonAsync<ControlRequest>(ctx.RequestAborted); }
            catch { req = null; }
            if (req is null || string.IsNullOrWhiteSpace(req.DeviceId))
                return Results.BadRequest(new { ok = false, message = "deviceId, index and action are required." });

            var (_, pdu, instanceCfg) = ResolveInstance(req.Instance);
            if (pdu is null)
                return Results.Json(new { ok = false, message = NoPdu }, statusCode: 404);
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
                // Via the write seam, which routes plugin devices to their plugin.
                else if (outletControl is not null)
                {
                    // Report what the write actually did.
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

        // Write an outlet's label on the PDU. Gated by PDU.ActionsEnabled.
        app.MapPost("/api/control/label", async (HttpContext ctx) =>
        {
            LabelRequest? req;
            try { req = await ctx.Request.ReadFromJsonAsync<LabelRequest>(ctx.RequestAborted); }
            catch { req = null; }
            if (req is null)
                return Results.BadRequest(new { ok = false, message = "A label request body is required." });

            var (_, pdu, instanceCfg) = ResolveInstance(req.Instance);
            if (pdu is null)
                return Results.Json(new { ok = false, message = NoPdu }, statusCode: 404);
            if (!instanceCfg.ActionsEnabled)
                return Results.Json(new { ok = false, message = "Write actions are disabled for this PDU instance (ActionsEnabled is false)." }, statusCode: 409);

            var target = (req.Target ?? "outlet").Trim().ToLowerInvariant();
            // Group labels target the OneView master; others need a deviceId.
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

        // Render the current form state as YAML.
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

                // Merge against the form state, not the file.
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
            if (!config.HASS.DiscoveryEnabled)
                return Results.Json(new { ok = false, message = "Home Assistant discovery is turned off. Turn it on and save; no restart needed." }, ConfigSchema.Json);

            await discovery.RequestRediscoverAsync(CancellationToken.None);
            return Results.Json(new { ok = true, message = "Discovery republish requested." }, ConfigSchema.Json);
        });

        app.MapPost("/api/discovery/clear", async () =>
        {
            // Not gated on DiscoveryEnabled.

            // First each service clears what it published.
            await discovery.RequestClearAsync(CancellationToken.None);

            // Then any of our other retained configs on the broker.
            var swept = 0;
            var message = "Cleared the retained Home Assistant discovery messages.";
            try
            {
                var prefix = config.HASS.DiscoveryTopic;
                var root = (prefix ?? "").Trim().Trim('/');
                var index = topicIndex;

                // The index only fills while being read.
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
                await Task.Delay(2000);   // let the retained burst arrive

                // Uncapped: Search caps at 200.
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
                Log.Warning($"Clear discovery: the broker sweep failed ({ex.Message}); only this run's topics were cleared.");
                message = "Cleared this run's discovery messages, but could not sweep the broker for older ones: " + ex.Message;
            }

            return Results.Json(new { ok = true, swept, message }, ConfigSchema.Json);
        });
    }

    /// <summary>Body of POST /api/control/outlet.</summary>
    private sealed record ControlRequest(string DeviceId, int Index, string Action, string? Instance = null);

    /// <summary>Body of POST /api/control/label.</summary>
    private sealed record LabelRequest(string DeviceId, string? Target, int Index, string? EntityKey, string? GroupKey, string Label, string? Instance = null);

    /// <summary>Body of POST /api/control/group.</summary>
    private sealed record GroupControlRequest(string GroupKey, string Action, string? Instance = null);

    /// <summary>One pivoted live-view row: an outlet/entity with its measurements + state.</summary>
    private static object BuildLiveEntity(string device, string source, string kind, int? number, string? state, IEnumerable<Models.PDU.Measurement> measurements)
    {
        var values = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);
        foreach (var m in measurements)
            if (!string.IsNullOrEmpty(m.Type) && double.TryParse(m.Value, System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out var v))
                values[m.Type] = v;
        return new { device, source, kind, number, state, values };
    }

    /// <summary>Parse a measurement string to a number, or null.</summary>
    private static double? ParseMeasure(string? s)
        => double.TryParse(s, System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out var v) ? v : null;

    /// <summary>Project measurements into the generated MQTT/Prometheus/EmonCMS paths.</summary>
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

    /// <summary>Render a config as an RpduConfig CR manifest, secrets redacted.</summary>
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

    /// <summary>Read an embedded wwwroot asset by file-name suffix.</summary>
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

    /// <summary>Read the operator update report from the CR <c>.status.update</c>, with a short timeout.</summary>
    private async Task<object?> ReadOperatorUpdateAsync(KubernetesConfigSource? k8s, CancellationToken ct)
    {
        if (k8s is null) return null;   // operator only runs with the Kubernetes config source
        try { return await Operator(op => op.Status(), new Core.Operator.OperatorReport { Message = "No check yet." }); }
        catch (Exception ex) { Log.Debug($"Could not read the operator's status: {ex.Message}"); return null; }
    }

    /// <summary>Ask the operator, or return <c>absent</c> outside Kubernetes.</summary>
    private Task<T> Operator<T>(Func<Core.Operator.IOperatorControl, Task<T>> ask, T absent)
        => deployOperator is null ? Task.FromResult(absent) : ask(deployOperator);

    /// <summary>Deployment's component label, or "".</summary>
    private static string ComponentOf(V1Deployment d)
        => d.Metadata?.Labels is { } l && l.TryGetValue("app.kubernetes.io/component", out var c) ? c : "";

    /// <summary>This app's Deployments, found via the running pod's labels.</summary>
    private async Task<IList<V1Deployment>> AppDeploymentsAsync(KubernetesConfigSource kube, CancellationToken ct)
    {
        var list = await kube.Client.AppsV1.ListNamespacedDeploymentAsync(kube.Namespace, labelSelector: await AppSelectorAsync(kube, ct), cancellationToken: ct);
        return list.Items;
    }

    /// <summary>Label selector for this release, from this pod or a default.</summary>
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

    /// <summary>Rollout-restart matching Deployments via the <c>restartedAt</c> annotation; returns names patched.</summary>
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

    // Case-insensitive property binding.
    private static readonly System.Text.Json.JsonSerializerOptions ProbeJson = new() { PropertyNameCaseInsensitive = true };

    /// <summary>Body of POST /api/modbus/probe.</summary>
    private sealed record ModbusProbeRequest(string Host, int Port, int UnitId, string? Framing, int TimeoutMs, List<EnergyFlowSource>? Items);

    /// <summary>Body of POST /api/config/import.</summary>
    private sealed record ConfigImportRequest(string? Yaml, string? Mode, string? Current);

    /// <summary>Body of POST /api/modbus/scan.</summary>
    private sealed record ModbusScanRequest(string Host, int Port, int UnitId, string? Framing, int TimeoutMs, int Start, int Count, string? RegisterType);

    /// <summary>A (node, metric) whose live value the Nodes editor wants.</summary>
    private sealed record LiveValueQuery(string? Node, string? Metric);

    /// <summary>The current export pass, or null when nothing is polled or configured.</summary>
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
