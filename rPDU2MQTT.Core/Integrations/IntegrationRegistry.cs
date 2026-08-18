using rPDU2MQTT.Classes;

namespace rPDU2MQTT.Core.Integrations;

/// <summary>
/// Every integration this build carries, and what each one can do.
///
/// <para>
/// The list is discovered, never written down. A hand-maintained registration list is precisely what this
/// work is removing: the same integration used to be named in <c>ServiceConfiguration</c>,
/// <c>StartupSummary</c>, <c>StatusReporter</c>, <c>ConfigurationFaults</c> and the GUI's nav, and any one
/// of them could be forgotten with no failure to show for it.
/// </para>
/// </summary>
public sealed class IntegrationRegistry
{
    private readonly IReadOnlyList<IIntegration> all;

    public IntegrationRegistry(IEnumerable<IIntegration> integrations)
        => all = integrations.OrderBy(i => i.Group).ThenBy(i => i.Id, StringComparer.Ordinal).ToList();

    /// <summary>Every registered integration, whether or not it is switched on.</summary>
    public IReadOnlyList<IIntegration> All => all;

    /// <summary>The integration with this id, or null. Ids are matched case-insensitively.</summary>
    public IIntegration? ById(string? id)
        => all.FirstOrDefault(i => string.Equals(i.Id, id, StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// The integrations that are switched on and correctly configured, with the capability
    /// <typeparamref name="T"/>. This is what the hosts iterate.
    /// </summary>
    public IReadOnlyList<(IIntegration Integration, T Capability)> Ready<T>(Config cfg) where T : class
        => all.Where(i => i is T && i.Enabled(cfg) && i.Misconfigured(cfg) is null)
              .Select(i => (i, (T)(object)i))
              .ToList();

    /// <summary>
    /// Every integration that is switched on but cannot run, with the reason. Reported at startup and on
    /// the Status board — an integration an operator has enabled and that is silently doing nothing is the
    /// failure this replaces.
    /// </summary>
    public IReadOnlyList<(IIntegration Integration, string Reason)> Faulted(Config cfg)
        => all.Where(i => i.Enabled(cfg))
              .Select(i => (i, i.Misconfigured(cfg)))
              .Where(x => x.Item2 is not null)
              .Select(x => (x.i, x.Item2!))
              .ToList();

    /// <summary>
    /// The action an integration offers under this name, or null — standard actions implied by its
    /// capabilities included. Used by the host to turn <c>/api/integrations/{id}/{action}</c> into a call
    /// without knowing what any integration offers.
    /// </summary>
    public IntegrationAction? Action(string? integrationId, string? actionName, Func<ExportPass?>? passFor = null)
        => ById(integrationId) is { } i ? IntegrationActions.Find(i, actionName, passFor) : null;

    /// <summary>Does this integration carry the capability <typeparamref name="T"/>?</summary>
    public static bool Has<T>(IIntegration integration) where T : class => integration is T;

    /// <summary>
    /// The capability names an integration carries, for the startup banner and the Status board — "EmonCMS:
    /// destination, history".
    /// </summary>
    public static IReadOnlyList<string> Capabilities(IIntegration integration)
    {
        var names = new List<string>();
        if (integration is IMeasurementDestination) names.Add("destination");
        if (integration is IConfigurationPublisher) names.Add("configures");
        if (integration is Flow.IMeasurementHistory) names.Add("history");
        if (integration is Flow.IFlowValueSource) names.Add("source");
        if (integration is IDeviceSourcePlugin) names.Add("device");
        if (integration is IDeviceControlPlugin) names.Add("control");
        if (integration is IValueSourcePlugin) names.Add("values");
        if (integration is INodeProvider) names.Add("discovers");
        if (integration is IIntegrationApi) names.Add("actions");
        return names;
    }
}
