using rPDU2MQTT.Classes;

namespace rPDU2MQTT.Core.Integrations;

/// <summary>Every discovered integration and its capabilities.</summary>
public sealed class IntegrationRegistry
{
    private readonly IReadOnlyList<IIntegration> all;

    public IntegrationRegistry(IEnumerable<IIntegration> integrations)
        => all = integrations.OrderBy(i => i.Group).ThenBy(i => i.Id, StringComparer.Ordinal).ToList();

    /// <summary>Every registered integration, enabled or not.</summary>
    public IReadOnlyList<IIntegration> All => all;

    /// <summary>Case-insensitive lookup by id.</summary>
    public IIntegration? ById(string? id)
        => all.FirstOrDefault(i => string.Equals(i.Id, id, StringComparison.OrdinalIgnoreCase));

    /// <summary>Enabled, correctly configured integrations with capability <typeparamref name="T"/>.</summary>
    public IReadOnlyList<(IIntegration Integration, T Capability)> Ready<T>(Config cfg) where T : class
        => all.Where(i => i is T && i.Enabled(cfg) && i.Misconfigured(cfg) is null)
              .Select(i => (i, (T)(object)i))
              .ToList();

    /// <summary>Enabled integrations that cannot run, with the reason.</summary>
    public IReadOnlyList<(IIntegration Integration, string Reason)> Faulted(Config cfg)
        => all.Where(i => i.Enabled(cfg))
              .Select(i => (i, i.Misconfigured(cfg)))
              .Where(x => x.Item2 is not null)
              .Select(x => (x.i, x.Item2!))
              .ToList();

    /// <summary>The named action an integration offers, including standard capability actions, or null.</summary>
    public IntegrationAction? Action(string? integrationId, string? actionName, Func<ExportPass?>? passFor = null)
        => ById(integrationId) is { } i ? IntegrationActions.Find(i, actionName, passFor) : null;

    public static bool Has<T>(IIntegration integration) where T : class => integration is T;

    /// <summary>Capability names for display.</summary>
    public static IReadOnlyList<string> Capabilities(IIntegration integration)
    {
        var names = new List<string>();
        if (integration is IMeasurementDestination) names.Add("destination");
        if (integration is IConfigurationPublisher) names.Add("configures");
        if (integration is Flow.IMeasurementHistory) names.Add("history");
        if (integration is Flow.IFlowValueSource) names.Add("source");
        if (integration is IDeviceSourcePlugin || integration is IPduInstanceProvider) names.Add("device");
        if (integration is IDeviceControlPlugin) names.Add("control");
        if (integration is IValueSourcePlugin) names.Add("values");
        if (integration is INodeProvider) names.Add("discovers");
        if (integration is IIntegrationApi) names.Add("actions");
        if (integration is IGuiPageProvider) names.Add("pages");
        return names;
    }
}
