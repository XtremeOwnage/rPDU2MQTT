using rPDU2MQTT.Classes;

namespace rPDU2MQTT.Core.Integrations;

/// <summary>
/// Where an integration belongs in the GUI's navigation. Carried here rather than in the client so a new
/// integration cannot be registered and then be missing from the nav — the two used to be separate lists.
/// </summary>
public enum IntegrationGroup
{
    /// <summary>Reads hardware into snapshots: the Vertiv rPDU poller.</summary>
    Sources,
    /// <summary>Supplies live values for flow nodes: MQTT, Modbus.</summary>
    Integrations,
    /// <summary>Receives readings and the flow hierarchy: MQTT, Home Assistant, Prometheus, EmonCMS.</summary>
    Destinations,
}

/// <summary>
/// One integration — a vendor or system this bridge talks to, such as EmonCMS, Prometheus or Home
/// Assistant.
///
/// <para>
/// An integration is <b>not</b> one capability. A vendor implements whichever capability interfaces it
/// supports and the host wires up exactly those: EmonCMS is a destination <i>and</i> a history provider;
/// Prometheus is both too; MQTT is a value source <i>and</i> a destination. Modelling a plugin as a single
/// interface would have forced one of those to be two plugins with two config sections, which is neither
/// how an operator thinks about them nor how they are configured.
/// </para>
/// <para>
/// Nothing here mentions Orleans, hosting, or the GUI, and nothing ever should. An integration declares
/// what it is and what it can do; the host decides where it runs, when it runs, and who owns it. Where a
/// capability genuinely needs cluster coordination — one owner of a serial gateway — it asks for it through
/// a Core interface (<see cref="ISingleOwnerLease"/>) that happens to be grain-backed today.
/// </para>
/// </summary>
public interface IIntegration
{
    /// <summary>
    /// Stable id, lowercase, matching the config section it reads ("emoncms", "prometheus"). This is the
    /// identity everything generic keys off: the status board, the test endpoint, the startup banner.
    /// </summary>
    string Id { get; }

    /// <summary>Human-readable name for the nav, the banner and the Status board ("EmonCMS").</summary>
    string DisplayName { get; }

    /// <summary>Which nav group this belongs to.</summary>
    IntegrationGroup Group { get; }

    /// <summary>
    /// Is this integration switched on in <paramref name="cfg"/>? Read live on every pass, so a toggle in
    /// the GUI takes effect without a restart — the reason registration cannot simply be skipped at
    /// startup for anything an operator can turn on later.
    /// </summary>
    bool Enabled(Config cfg);

    /// <summary>
    /// Why this integration cannot run as configured (a missing URL, an absent API key), or null when it is
    /// ready. Replaces the per-integration methods on <c>ConfigurationFaults</c>; a fault disables just this
    /// integration and is reported, rather than stopping the bridge.
    /// </summary>
    string? Misconfigured(Config cfg) => null;

    /// <summary>
    /// Is the far end answering? Shown on the Status board, and behind the GUI's Test button. Default is
    /// "nothing to check", which is the honest answer for an integration with no remote end.
    /// </summary>
    Task<(bool Ok, string Detail)> ProbeAsync(Config cfg, CancellationToken ct)
        => Task.FromResult((true, "no connection to check"));
}
