using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Flow;

namespace rPDU2MQTT.Core.Integrations;

/// <summary>A tier a plugin adds to the energy export, published like a node: its own topic and Home Assistant device.</summary>
/// <param name="Energy">Its lifetime energy; null when it is not known.</param>
/// <param name="EnergyToday">Today's energy; null when it is not known.</param>
/// <param name="Area">The Home Assistant area its device is filed in when first created; null for none.</param>
/// <param name="Fields">Extra fields for its state payload, after its id.</param>
public sealed record ContributedTier(string Id, string Label, string Kind, double Power, double? Energy, double? EnergyToday,
    string? Area = null, IReadOnlyDictionary<string, object?>? Fields = null);

/// <summary>
/// A plugin that publishes tiers of its own beside the flow's nodes, such as a total per room. A tier whose
/// power is not known is left out, exactly as a node's is.
/// </summary>
public interface IExportContributor
{
    IReadOnlyList<ContributedTier> Tiers(ExportPass pass, Config cfg);

    /// <summary>The id of every tier it may publish, so clearing orphaned discovery leaves them be.</summary>
    IReadOnlyList<string> TierIds(Config cfg);
}

/// <summary>A plugin that knows which Home Assistant area each node's device belongs in.</summary>
public interface IAreaProvider
{
    /// <summary>The area name for each node it places, by node id.</summary>
    IReadOnlyDictionary<string, string> Areas(Config cfg, FlowTopology topology);
}

/// <summary>Every loaded export contributor and area provider, for the destinations that use them.</summary>
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

    /// <summary>Each node's area; where two providers place one node, the first loaded wins.</summary>
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
