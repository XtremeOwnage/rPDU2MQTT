using HiveMQtt.Client;
using Microsoft.AspNetCore.Builder;
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
    private WebApplication? app;

    public HealthService(Config cfg, IHiveMQClient mqtt, HealthState health)
    {
        this.cfg = cfg;
        this.mqtt = mqtt;
        this.health = health;
    }

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        if (!cfg.Health.Enabled)
            return;

        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { Args = Array.Empty<string>() });
        builder.Logging.ClearProviders();
        builder.WebHost.UseUrls($"http://*:{cfg.Health.Port}");

        app = builder.Build();
        app.MapGet("/healthz", () => Results.Text("OK"));
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
    {
        if (!mqtt.IsConnected())
            return "MQTT not connected";

        var last = health.LastPollUtc;
        if (last is null)
            return "no successful PDU poll yet";

        var staleAfter = TimeSpan.FromSeconds(Math.Max(30, cfg.Primary.PollInterval * 3));
        var age = DateTime.UtcNow - last.Value;
        if (age >= staleAfter)
            return $"last PDU poll {age.TotalSeconds:0}s ago (> {staleAfter.TotalSeconds:0}s)";

        return null;
    }
}
