using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Flow;

namespace rPDU2MQTT.Core.Integrations;

/// <summary>A plugin-published tier.</summary>
/// <param name="Area">Home Assistant suggested area.</param>
/// <param name="Fields">Extra state payload fields.</param>
public sealed record ContributedTier(string Id, string Label, string Kind, double? Power, double? Energy, double? EnergyToday,
    string? Area = null, IReadOnlyDictionary<string, object?>? Fields = null, IReadOnlyList<TierSensor>? Sensors = null);

/// <summary>An extra Home Assistant sensor on a tier's device, read from <c>Fields[Key]</c>.</summary>
public sealed record TierSensor(string Key, string Name, string DeviceClass, string Units);

/// <summary>Publishes tiers beside the flow's nodes.</summary>
public interface IExportContributor
{
    IReadOnlyList<ContributedTier> Tiers(ExportPass pass, Config cfg);

    /// <summary>Every tier id it may publish; kept by the orphan sweep.</summary>
    IReadOnlyList<string> TierIds(Config cfg);
}

/// <summary>Home Assistant areas by node id.</summary>
public interface IAreaProvider
{
    IReadOnlyDictionary<string, string> Areas(Config cfg, FlowTopology topology);
}

/// <summary>Loaded export contributors and area providers.</summary>
public sealed class ExportContributions
{
    public ExportContributions(IEnumerable<object> contributors)
    {
        var all = contributors.ToList();
        Exports = all.OfType<IExportContributor>().ToList();
        AreaProviders = all.OfType<IAreaProvider>().ToList();
    }

    public static ExportContributions None { get; } = new([]);

    public IReadOnlyList<IExportContributor> Exports { get; }
    public IReadOnlyList<IAreaProvider> AreaProviders { get; }

    /// <summary>First provider wins.</summary>
    public IReadOnlyDictionary<string, string> Areas(Config cfg, FlowTopology topology)
    {
        var areas = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var p in AreaProviders)
            foreach (var (node, area) in p.Areas(cfg, topology))
                areas.TryAdd(node, area);
        return areas;
    }

    public IEnumerable<ContributedTier> Tiers(ExportPass pass, Config cfg) => Exports.SelectMany(e => e.Tiers(pass, cfg));

    public IEnumerable<string> TierIds(Config cfg) => Exports.SelectMany(e => e.TierIds(cfg));
}
