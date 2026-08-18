using rPDU2MQTT.Classes;

namespace rPDU2MQTT.Core.Integrations;

/// <summary>
/// Every action an integration exposes: the standard ones implied by the capabilities it carries, plus
/// whatever bespoke ones it declares through <see cref="IIntegrationApi"/>.
///
/// <para>
/// A capability an integration already implements should not have to be re-declared as an action to be
/// reachable. Implementing <see cref="IConfigurationPublisher"/> <i>is</i> saying "I can publish and sweep
/// the far end", so <c>publish</c> and <c>sweep</c> appear on the API and in the GUI with no further
/// wiring — the same reasoning that makes a health probe an action for free. <see cref="IIntegrationApi"/>
/// is then only for what nothing else implies: browsing broker topics, scanning a Modbus register block.
/// </para>
/// <para>
/// Note the shape of every handler: it takes a context and returns an object. The API layer turns that into
/// a route, the GUI turns it into a button, and neither the integration nor this file mentions HTTP.
/// </para>
/// </summary>
public static class IntegrationActions
{
    /// <summary>The well-known action names, so callers and the GUI agree without matching on strings.</summary>
    public const string Probe = "probe";
    public const string Publish = "publish";
    public const string Sweep = "sweep";

    /// <summary>
    /// Everything <paramref name="integration"/> can be asked to do, standard actions first.
    /// </summary>
    /// <param name="passFor">
    /// Supplies the current <see cref="ExportPass"/> for actions that need to know what exists — publishing
    /// configuration describes the nodes and devices there are right now. Null where no pass is available
    /// (a UI-only process with a cold cache), in which case those actions decline rather than publishing an
    /// empty world, which would read at the far end as "everything is gone".
    /// </param>
    public static IReadOnlyList<IntegrationAction> For(
        IIntegration integration, Func<ExportPass?>? passFor = null)
    {
        var actions = new List<IntegrationAction>
        {
            new(Probe, "Test", $"Check that {integration.DisplayName} is reachable and answering.",
                ActionEffect.Read,
                async (ctx, ct) =>
                {
                    var (ok, detail) = await integration.ProbeAsync(ctx.Config, ct);
                    return new { ok, detail };
                }),
        };

        if (integration is IConfigurationPublisher publisher)
        {
            actions.Add(new(Publish, "Publish configuration",
                $"Bring {integration.DisplayName}'s description of this system up to date — the entities, "
                + "feeds or dashboards it needs in order to record what is sent.",
                ActionEffect.Write,
                async (ctx, ct) =>
                {
                    if (!publisher.PublishingEnabled(ctx.Config))
                        return new { ok = false, message = $"Publishing to {integration.DisplayName} is switched off." };
                    if (passFor?.Invoke() is not { } pass)
                        return new { ok = false, message = "No data yet — wait for the first poll, then try again." };
                    return new { ok = true, message = await publisher.PublishAsync(pass, ct) };
                }));

            actions.Add(new(Sweep, "Remove what is no longer ours",
                $"Delete the entries {integration.DisplayName} still holds that this configuration would no "
                + "longer publish — a renamed node, a PDU that was removed.",
                ActionEffect.Destructive,
                async (ctx, ct) =>
                {
                    if (passFor?.Invoke() is not { } pass)
                        return new { ok = false, message = "No data yet — sweeping against an empty world would remove everything." };
                    return new { ok = true, message = await publisher.SweepAsync(pass, ct) };
                }));
        }

        if (integration is IIntegrationApi api)
            actions.AddRange(api.Actions);

        return actions;
    }

    /// <summary>The named action, or null. Matching is case-insensitive.</summary>
    public static IntegrationAction? Find(
        IIntegration integration, string? name, Func<ExportPass?>? passFor = null)
        => For(integration, passFor).FirstOrDefault(a => string.Equals(a.Name, name, StringComparison.OrdinalIgnoreCase));
}
