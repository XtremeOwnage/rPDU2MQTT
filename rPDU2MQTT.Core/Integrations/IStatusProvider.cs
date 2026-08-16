using rPDU2MQTT.Classes;

namespace rPDU2MQTT.Core.Integrations;

/// <summary>How an integration is doing, in the four states a board can colour.</summary>
public enum HealthLevel
{
    /// <summary>Switched off. Not a problem, and must not be coloured like one.</summary>
    Off,
    /// <summary>Working.</summary>
    Good,
    /// <summary>Running but not yet proven — enabled with nothing reported, or degraded.</summary>
    Warn,
    /// <summary>Enabled and not working.</summary>
    Bad,
}

/// <summary>An integration's health, as it would like to be shown.</summary>
/// <param name="Level">Which of the four states.</param>
/// <param name="Summary">Two or three words for the card's headline — "Exporting", "No data yet".</param>
/// <param name="Detail">The sentence under it. Null when the summary says everything.</param>
public sealed record IntegrationHealth(HealthLevel Level, string Summary, string? Detail = null);

/// <summary>
/// An integration that decides for itself what its own health means.
///
/// <para>
/// The default derivation below — off / misconfigured / whatever it last did — is right for most, and an
/// integration only implements this when the honest answer is more specific than that. EmonCMS is the
/// motivating example: only the process actually running the export has an outcome, so an outcome-free
/// report from any other process must not overwrite a known one. That judgement belongs to the thing it is
/// about, not to a <c>switch</c> somewhere in the status reporter — which is where it used to live, one
/// branch per integration, with no way for a plugin to have an opinion at all.
/// </para>
/// <para>
/// Deliberately not <c>IHealthCheck</c>. That would put <c>Microsoft.Extensions.Diagnostics.HealthChecks</c>
/// in front of every plugin author, and this type says more than Healthy/Degraded/Unhealthy does — the
/// board needs a summary and a detail line. The host adapts these into real health checks, so
/// <c>/healthz</c>, <c>/readyz</c> and a Kubernetes probe see them without the plugin knowing.
/// </para>
/// </summary>
public interface IStatusProvider
{
    /// <summary>
    /// This integration's health right now. Called on a timer, so it must be cheap and must not perform I/O
    /// — a probe that reaches the far end is <see cref="IIntegration.ProbeAsync"/>, which the operator
    /// triggers.
    /// </summary>
    IntegrationHealth Status(Config cfg);
}

/// <summary>Working out an integration's health when it has no opinion of its own.</summary>
public static class IntegrationHealthDefaults
{
    /// <summary>
    /// The one thing that can be said about any integration without knowing what it talks to.
    /// </summary>
    /// <param name="last">What it last did, from <see cref="IntegrationStatus"/>, or null if never.</param>
    public static IntegrationHealth For(IIntegration integration, Config cfg, IntegrationStatus.Entry? last = null)
    {
        if (integration is IStatusProvider own) return own.Status(cfg);

        if (!integration.Enabled(cfg))
            return new(HealthLevel.Off, "Disabled");

        // Enabled but unusable is its own state and has to be visible: it will never attempt anything,
        // which would otherwise read as a healthy card that simply never counts up.
        if (integration.Misconfigured(cfg) is { } fault)
            return new(HealthLevel.Bad, "Misconfigured", fault);

        if (last?.LastOk == false)
            return new(HealthLevel.Bad, "Failing", last.LastError);

        if (last?.LastOk == true)
            return new(HealthLevel.Good, "Exporting", $"{last.Count} value(s) last pass");

        return new(HealthLevel.Warn, "No data yet", "Enabled, nothing reported yet");
    }
}
