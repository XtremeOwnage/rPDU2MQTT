using System.Text.Json;
using rPDU2MQTT.Services.Gui;

namespace rPDU2MQTT.Plugin.Locations;

/// <summary>Sites, floors, rooms and areas.</summary>
public sealed class LocationsPlugin : IIntegration, IConfigurablePlugin, IEntityExtensionProvider, IExportContributor, IAreaProvider,
    IIntegrationApi, IPluginHostUser, IGuiPageProvider, IStatusProvider, ISingleOwnerLeaseUser, IPluginStoreUser
{
    public string Id => LocationSettings.PluginId;
    public string DisplayName => "Locations";
    public IntegrationGroup Group => IntegrationGroup.Integrations;

    public IReadOnlyList<GuiPage> Pages { get; } =
    [
        new("locations", "Locations", "Energy Flow", "⌂", "Plugins.locations,EnergyFlow.Nodes"),
        new("floor-plans", "Floor Plans", "Energy Flow", "⌗", "Plugins.locations,EnergyFlow.Panels"),
    ];

    public string? PageAsset(string file) => GuiPageAssets.Read(typeof(LocationsPlugin).Assembly, file);

    public IReadOnlyList<string> PageSettings { get; } = ["Sites", "Placements", "Runs", "AutoLocations"];

    public Type ConfigType => typeof(LocationSettings);

    /// <summary>Read per call, so unsaved page edits can be totalled.</summary>
    public void ApplyConfig(object settings) { }

    public IReadOnlyDictionary<string, Type> EntityExtensions { get; } = new Dictionary<string, Type>
    {
        [EntityKind.Node] = typeof(NodeLocation),
        [EntityKind.Panel] = typeof(PanelLocation),
        [EntityKind.Breaker] = typeof(BreakerRooms),
    };

    private IPluginHost? host;
    public void UseHost(IPluginHost host) { this.host = host; StartRunner(); }

    private IPluginStore store = new NullPluginStore();
    public void UseStore(IPluginStore store) => this.store = store;

    private HaSyncRunner? runner;
    private ISingleOwnerLease? lease;
    public void UseLease(ISingleOwnerLease lease) { this.lease = lease; StartRunner(); }

    private void StartRunner()
    {
        if (host is not { } h || lease is null || runner is not null) return;
        runner = new HaSyncRunner(Endpoints, () => h.Config, lease);
        runner.Start();
    }

    public bool Enabled(Config cfg) => true;

    public IntegrationHealth Status(Config cfg)
    {
        var floors = LocationSettings.Of(cfg).Sites.Sum(s => s.Floors?.Count ?? 0);
        var detail = floors == 1 ? "1 floor" : $"{floors} floors";
        if (runner?.LastAt is { } at) detail += $" · published {at.ToLocalTime():g}";
        if (runner is { LastOk: false }) return new(HealthLevel.Warn, "Publish failed", runner.LastMessage);
        return new(HealthLevel.Good, "Available", detail);
    }

    private LocationContributor contributor => field ??= new(() => host?.LiveValues);
    public IReadOnlyList<ContributedTier> Tiers(ExportPass pass, Config cfg) => contributor.Tiers(pass, cfg);
    public IReadOnlyList<string> TierIds(Config cfg) => contributor.TierIds(cfg);
    public IReadOnlyDictionary<string, string> Areas(Config cfg, FlowTopology topology) => contributor.Areas(cfg, topology);

    public IReadOnlyList<IntegrationAction> Actions =>
    [
        new("places", "Places", "Every site, floor, room and area, for a picker.", ActionEffect.Read,
            (ctx, _) => Task.FromResult<object?>(Choices(ctx.Config, null)), Listed: false),
        new("rooms", "Rooms", "Every room and area, for a picker.", ActionEffect.Read,
            (ctx, _) => Task.FromResult<object?>(Choices(ctx.Config, [LocationKind.Room, LocationKind.Area])), Listed: false),
        new("nodes", "Nodes", "Every node, for a picker.", ActionEffect.Read,
            (ctx, _) => Task.FromResult<object?>(Endpoints().Nodes()), Listed: false),
        new("totals", "Totals", "The location tree with each place's total, every circuit and every placement.", ActionEffect.Read,
            async (ctx, ct) => await Endpoints().TotalsAsync(Posted(ctx), Metric(ctx), Period(ctx), ct), Listed: false),
        new("series", "Series", "One place's total through a window, from history.", ActionEffect.Read,
            async (ctx, ct) => await Endpoints().SeriesAsync(Posted(ctx), ctx.Arg("location") ?? "", ctx.Int("minutes", 1440), ctx.Arg("step"), ct), Listed: false),
        new("migrate", "Tags to rooms", "Every tag in use, and given mappings, the rooms and areas they would become.", ActionEffect.Read,
            (ctx, _) => Task.FromResult<object?>(Endpoints().Migrate(ctx.Body)), Listed: false),
        new("areas-preview", "Preview areas", "What publishing rooms as Home Assistant areas would change.", ActionEffect.Read,
            async (ctx, ct) => await Endpoints().AreasAsync(Posted(ctx), apply: false, ct), Listed: false),
        new("areas-apply", "Publish areas", "Create, rename and link Home Assistant areas for each room, and put devices in them.", ActionEffect.Write,
            async (ctx, ct) => await Endpoints().AreasAsync(Posted(ctx), apply: true, ct), Listed: false),
    ];

    private LocationEndpoints Endpoints() =>
        new(host ?? throw new InvalidOperationException("The Locations plugin has not been started."), store);

    private static object Choices(Config cfg, string[]? kinds) =>
        LocationIndex.For(cfg).All.Where(e => kinds is null || kinds.Contains(e.Kind))
            .Select(e => new[] { e.Id, Describe(e) }).ToArray();

    private static string Describe(LocationEntry e) => e.Kind switch
    {
        LocationKind.Site => e.Label,
        LocationKind.Floor => "  " + e.Label,
        LocationKind.Area => $"    {e.Label} (area)",
        _ => "    " + e.Label,
    };

    /// <summary>The posted config, else the saved one.</summary>
    private static Config Posted(IntegrationActionContext ctx) =>
        string.IsNullOrWhiteSpace(ctx.Body) ? ctx.Config : ConfigSchema.FromJson(ctx.Body);

    private static string Metric(IntegrationActionContext ctx) =>
        string.IsNullOrWhiteSpace(ctx.Arg("metric")) ? FlowGraphBuilder.DefaultMetric : ctx.Arg("metric")!;

    private static string? Period(IntegrationActionContext ctx) => ctx.Arg("period") is "today" or "week" ? ctx.Arg("period") : null;
}
