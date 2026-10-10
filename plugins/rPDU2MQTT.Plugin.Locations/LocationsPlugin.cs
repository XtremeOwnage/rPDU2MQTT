using System.Text.Json;
using rPDU2MQTT.Services.Gui;

namespace rPDU2MQTT.Plugin.Locations;

/// <summary>
/// Sites, floors, rooms and areas: where each node, panel and circuit is, energy totalled per place, places
/// published as tiers and Home Assistant areas, and the Floor Plans page.
/// </summary>
public sealed class LocationsPlugin : IIntegration, IConfigurablePlugin, IEntityExtensionProvider, IExportContributor, IAreaProvider,
    IIntegrationApi, IPluginHostUser, IGuiPageProvider, IStatusProvider
{
    public string Id => LocationSettings.PluginId;
    public string DisplayName => "Locations";
    public IntegrationGroup Group => IntegrationGroup.Integrations;

    public IReadOnlyList<GuiPage> Pages { get; } =
    [
        new("floor-plans", "Floor Plans", "Energy Flow", "⌗", "Plugins.locations,EnergyFlow.Panels"),
    ];

    public string? PageAsset(string file) => GuiPageAssets.Read(typeof(LocationsPlugin).Assembly, file);

    public IReadOnlyList<string> PageSettings { get; } = ["Sites", "Placements", "Runs", "AutoLocations"];

    public Type ConfigType => typeof(LocationSettings);

    /// <summary>Settings are read from the configuration each time, so a page's unsaved edits can be totalled too.</summary>
    public void ApplyConfig(object settings) { }

    public IReadOnlyDictionary<string, Type> EntityExtensions { get; } = new Dictionary<string, Type>
    {
        [EntityKind.Node] = typeof(NodeLocation),
        [EntityKind.Panel] = typeof(PanelLocation),
        [EntityKind.Breaker] = typeof(BreakerRooms),
    };

    private IPluginHost? host;
    public void UseHost(IPluginHost host) => this.host = host;

    public bool Enabled(Config cfg) => true;

    public IntegrationHealth Status(Config cfg)
    {
        var floors = LocationSettings.Of(cfg).Sites.Sum(s => s.Floors?.Count ?? 0);
        return new(HealthLevel.Good, "Available", floors == 1 ? "1 floor" : $"{floors} floors");
    }

    private readonly LocationContributor contributor = new();
    public IReadOnlyList<ContributedTier> Tiers(ExportPass pass, Config cfg) => contributor.Tiers(pass, cfg);
    public IReadOnlyList<string> TierIds(Config cfg) => contributor.TierIds(cfg);
    public IReadOnlyDictionary<string, string> Areas(Config cfg, FlowTopology topology) => contributor.Areas(cfg, topology);

    public IReadOnlyList<IntegrationAction> Actions =>
    [
        new("places", "Places", "Every site, floor, room and area, for a picker.", ActionEffect.Read,
            (ctx, _) => Task.FromResult<object?>(Choices(ctx.Config, null)), Listed: false),
        new("rooms", "Rooms", "Every room and area, for a picker.", ActionEffect.Read,
            (ctx, _) => Task.FromResult<object?>(Choices(ctx.Config, [LocationKind.Room, LocationKind.Area])), Listed: false),
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
        new(host ?? throw new InvalidOperationException("The Locations plugin has not been started."));

    private static object Choices(Config cfg, string[]? kinds) =>
        LocationIndex.For(cfg).All.Where(e => kinds is null || kinds.Contains(e.Kind))
            .Select(e => new[] { e.Id, Describe(e) }).ToArray();

    /// <summary>Indented by depth, so the tree reads in a flat list.</summary>
    private static string Describe(LocationEntry e) => e.Kind switch
    {
        LocationKind.Site => e.Label,
        LocationKind.Floor => "  " + e.Label,
        LocationKind.Area => $"    {e.Label} (area)",
        _ => "    " + e.Label,
    };

    /// <summary>The configuration a page sent, as it is on screen before Save; the saved one when it sent none.</summary>
    private static Config Posted(IntegrationActionContext ctx) =>
        string.IsNullOrWhiteSpace(ctx.Body) ? ctx.Config : ConfigSchema.FromJson(ctx.Body);

    private static string Metric(IntegrationActionContext ctx) =>
        string.IsNullOrWhiteSpace(ctx.Arg("metric")) ? FlowGraphBuilder.DefaultMetric : ctx.Arg("metric")!;

    private static string? Period(IntegrationActionContext ctx) => ctx.Arg("period") is "today" or "week" ? ctx.Arg("period") : null;
}
