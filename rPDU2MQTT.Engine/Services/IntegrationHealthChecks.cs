using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Integrations;

namespace rPDU2MQTT.Services;

/// <summary>
/// Adapts an integration's own health into a standard <see cref="IHealthCheck"/>, so every integration —
/// built-in or plugin — appears in <c>Microsoft.Extensions.Diagnostics.HealthChecks</c> and therefore in
/// anything reading it: the health endpoints, a Kubernetes probe, a dashboard scraping the standard shape.
///
/// <para>
/// The adapter lives here rather than in the contract so a plugin author never sees the health-check
/// package, and so the contract can say more than Healthy/Degraded/Unhealthy — the Status board wants a
/// summary and a detail line, which <see cref="HealthCheckResult"/> flattens.
/// </para>
/// </summary>
public sealed class IntegrationHealthCheck : IHealthCheck
{
    private readonly IIntegration integration;
    private readonly Config cfg;
    private readonly IntegrationStatus status;

    public IntegrationHealthCheck(IIntegration integration, Config cfg, IntegrationStatus status)
    {
        this.integration = integration;
        this.cfg = cfg;
        this.status = status;
    }

    public Task<HealthCheckResult> CheckHealthAsync(HealthCheckContext context, CancellationToken ct = default)
    {
        var health = IntegrationHealthDefaults.For(integration, cfg, status.For(integration.Id));
        var description = string.IsNullOrWhiteSpace(health.Detail) ? health.Summary : $"{health.Summary} — {health.Detail}";

        return Task.FromResult(health.Level switch
        {
            // An integration nobody switched on is not a degraded system; reporting it as one would make a
            // minimal install permanently unhealthy.
            HealthLevel.Off => HealthCheckResult.Healthy($"{integration.DisplayName}: disabled"),
            HealthLevel.Good => HealthCheckResult.Healthy($"{integration.DisplayName}: {description}"),
            HealthLevel.Warn => HealthCheckResult.Degraded($"{integration.DisplayName}: {description}"),
            _ => HealthCheckResult.Unhealthy($"{integration.DisplayName}: {description}"),
        });
    }
}

/// <summary>Registers one health check per integration, named for its id.</summary>
public static class IntegrationHealthCheckRegistration
{
    /// <summary>
    /// Add a check per integration. Tagged <c>integration</c> so a caller can filter to just these — a
    /// readiness probe should not fail because an optional exporter is degraded.
    /// </summary>
    public static IHealthChecksBuilder AddIntegrationChecks(this IHealthChecksBuilder builder, IntegrationRegistry registry)
    {
        foreach (var integration in registry.All)
            builder.Add(new HealthCheckRegistration(
                name: integration.Id,
                factory: sp => new IntegrationHealthCheck(
                    integration,
                    sp.GetRequiredService<Config>(),
                    sp.GetRequiredService<IntegrationStatus>()),
                failureStatus: HealthStatus.Degraded,
                tags: ["integration"]));
        return builder;
    }
}
