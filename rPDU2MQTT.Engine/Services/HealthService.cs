using HiveMQtt.Client;
using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Helpers;

namespace rPDU2MQTT.Services;

/// <summary>
/// Lightweight HTTP health endpoints for container probes, independent of the optional GUI:
/// <c>/healthz</c> (liveness — the process is up) and <c>/readyz</c> (readiness — MQTT is connected
/// and the PDU has been polled recently). Hosted on its own port when <c>Health.Enabled</c>.
/// </summary>
public sealed class HealthService : IHostedService, IAsyncDisposable
{
    private readonly Config cfg;
    private readonly IHiveMQClient mqtt;
    private readonly HealthState health;
    // Every integration this build carries, and what each last did — exposed as standard health checks.
    private readonly Core.Integrations.IntegrationRegistry? integrations;
    private readonly Core.Integrations.IntegrationStatus? status;
    private readonly Core.LeaderState? leader;
    private WebApplication? app;

    public HealthService(Config cfg, IHiveMQClient mqtt, HealthState health,
        Core.Integrations.IntegrationRegistry? integrations = null, Core.Integrations.IntegrationStatus? status = null,
        Core.LeaderState? leader = null)
    {
        this.cfg = cfg;
        this.mqtt = mqtt;
        this.health = health;
        this.integrations = integrations;
        this.status = status;
        this.leader = leader;
    }

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        if (!cfg.Health.Enabled)
            return;

        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { Args = Array.Empty<string>() });
        builder.Logging.ClearProviders();
        builder.WebHost.UseUrls($"http://*:{cfg.Health.Port}");

        // Every integration — built-in or plugin — becomes a standard health check, so anything that reads
        // the .NET health model sees them without knowing this project's vocabulary.
        if (integrations is not null && status is not null)
        {
            builder.Services.AddSingleton(cfg);
            builder.Services.AddSingleton(status);
            builder.Services.AddHealthChecks().AddIntegrationChecks(integrations);
        }

        app = builder.Build();
        app.MapGet("/healthz", () => Results.Text("OK"));
        // The integration detail, as the standard health model reports it. Separate from /readyz on
        // purpose: an optional exporter being degraded is not a reason to take this pod out of service.
        app.MapHealthChecks("/health/integrations", new Microsoft.AspNetCore.Diagnostics.HealthChecks.HealthCheckOptions
        {
            Predicate = r => r.Tags.Contains("integration"),
            ResponseWriter = async (context, report) =>
            {
                context.Response.ContentType = "application/json";
                await context.Response.WriteAsJsonAsync(new
                {
                    status = report.Status.ToString(),
                    entries = report.Entries.ToDictionary(
                        e => e.Key,
                        e => new { status = e.Value.Status.ToString(), description = e.Value.Description }),
                });
            },
        });

        app.MapGet("/readyz", () =>
        {
            var reason = NotReadyReason();
            return reason is null
                ? Results.Text("READY")
                : Results.Text($"NOT READY: {reason}", "text/plain", statusCode: StatusCodes.Status503ServiceUnavailable);
        });

        await app.StartAsync(cancellationToken);
        Log.Information($"Health endpoints listening on http://*:{cfg.Health.Port} (/healthz, /readyz).");
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        if (app is not null)
            await app.StopAsync(cancellationToken);
    }

    public async ValueTask DisposeAsync()
    {
        if (app is not null)
            await app.DisposeAsync();
    }

    /// <summary>
    /// Ready when MQTT is connected and the PDU has been polled recently. Returns the reason it is
    /// NOT ready, or <see langword="null"/> when ready.
    /// </summary>
    private string? NotReadyReason()
        => NotReadyReason(mqtt.IsConnected(), health.LastPollUtc, leader, cfg.Primary.PollInterval, DateTime.UtcNow);

    /// <summary>
    /// The readiness rule, on its own so it can be tested.
    ///
    /// <para>
    /// Under a leader lease (#506) ready means <i>ready to take over</i>. A standby does not poll — the old pod
    /// still is, and many gateways accept one client — so "polled recently" cannot be asked of it. It is ready
    /// once it is connected and can reach the lease: then the old pod can be told to stop, and this one takes
    /// over within a second of it letting go. A leader just promoted is given one staleness window to make its
    /// first poll, so the handover does not take it out of service for the length of one.
    /// </para>
    /// </summary>
    internal static string? NotReadyReason(bool mqttConnected, DateTime? lastPollUtc, Core.LeaderState? leader, int pollInterval, DateTime now)
    {
        if (!mqttConnected)
            return "MQTT not connected";

        if (leader is { Coordinated: true, IsLeader: false })
            return leader.StandbyReason is { } why && why.StartsWith("the lease store", StringComparison.Ordinal)
                ? $"standby, and cannot take over: {why}"
                : null;

        var staleAfter = TimeSpan.FromSeconds(Math.Max(30, pollInterval * 3));
        var promotedRecently = leader is { Coordinated: true, LeaderSinceUtc: { } since } && now - since < staleAfter;

        if (lastPollUtc is null)
            return promotedRecently ? null : "no successful PDU poll yet";

        var age = now - lastPollUtc.Value;
        if (age >= staleAfter && !promotedRecently)
            return $"last PDU poll {age.TotalSeconds:0}s ago (> {staleAfter.TotalSeconds:0}s)";

        return null;
    }
}
