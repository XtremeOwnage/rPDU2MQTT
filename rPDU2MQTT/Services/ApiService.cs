using HiveMQtt.Client;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core;
using rPDU2MQTT.Helpers;
using rPDU2MQTT.Models.Config;
using Scalar.AspNetCore;

namespace rPDU2MQTT.Services;

/// <summary>
/// A read-only REST API (<c>/api/v1/*</c>) with OpenAPI + a Scalar docs UI, hosted on its own port and
/// independent of the GUI. Surfaces the v2 pipeline state — instances, latest snapshots, readings and
/// health — for monitoring/automation. Unauthenticated like the health endpoints; gate by network.
/// This is the seed of the eventual standalone <c>Api</c> project (phase 6).
/// </summary>
public sealed class ApiService : IHostedService, IAsyncDisposable
{
    private readonly Config cfg;
    private readonly PduInstanceRegistry registry;
    private readonly ISnapshotCache snapshots;
    private readonly HealthState health;
    private readonly IHiveMQClient mqtt;
    private WebApplication? app;

    public ApiService(Config cfg, PduInstanceRegistry registry, ISnapshotCache snapshots, HealthState health, IHiveMQClient mqtt)
    {
        this.cfg = cfg;
        this.registry = registry;
        this.snapshots = snapshots;
        this.health = health;
        this.mqtt = mqtt;
    }

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        if (!cfg.Api.Enabled)
            return;

        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { Args = Array.Empty<string>() });
        builder.Logging.ClearProviders();
        builder.WebHost.UseUrls($"http://*:{cfg.Api.Port}");
        builder.Services.AddOpenApi();

        app = builder.Build();
        app.MapOpenApi();                       // /openapi/v1.json
        app.MapScalarApiReference();            // /scalar/v1 (docs UI)
        app.MapGet("/", () => Results.Redirect("/scalar/v1"));

        MapV1(app);

        await app.StartAsync(cancellationToken);
        Log.Information($"REST API listening on http://*:{cfg.Api.Port} (docs at /scalar/v1).");
    }

    private void MapV1(WebApplication app)
    {
        var v1 = app.MapGroup("/api/v1").WithTags("rPDU2MQTT");

        v1.MapGet("/instances", () =>
            cfg.Pdus.Select(kv => new InstanceDto(
                kv.Key,
                string.Equals(kv.Key, registry.PrimaryId, StringComparison.OrdinalIgnoreCase),
                kv.Value.Connection?.Host,
                kv.Value.PollInterval,
                kv.Value.ActionsEnabled)).ToList())
            .WithName("ListInstances").WithSummary("List the configured PDU instances.");

        v1.MapGet("/health", () => new HealthDto(
                health.StartedUtc,
                (long)health.Uptime.TotalSeconds,
                mqtt.IsConnected(),
                health.LastPollUtc))
            .WithName("GetHealth").WithSummary("Bridge liveness: uptime, MQTT connectivity, last poll.");

        v1.MapGet("/snapshots", () =>
        {
            var now = DateTime.UtcNow;
            return snapshots.All
                .Select(s => new SnapshotDto(s.InstanceId, s.TimestampUtc, (now - s.TimestampUtc).TotalSeconds))
                .OrderBy(s => s.InstanceId)
                .ToList();
        }).WithName("ListSnapshots").WithSummary("Latest snapshot timestamp/age per instance.");

        v1.MapGet("/readings", (string? instance) =>
        {
            var sources = string.IsNullOrEmpty(instance)
                ? snapshots.All
                : snapshots.All.Where(s => string.Equals(s.InstanceId, instance, StringComparison.OrdinalIgnoreCase));

            return sources
                .SelectMany(s => MetricsHelper.EnumerateReadings(s.Data)
                    .Select(r => new ReadingDto(s.InstanceId, r.Device, r.Source, r.Type, r.Value, r.Units)))
                .OrderBy(r => r.InstanceId).ThenBy(r => r.Device).ThenBy(r => r.Source).ThenBy(r => r.Type)
                .ToList();
        }).WithName("ListReadings").WithSummary("Flattened measurements from the latest snapshot(s); filter with ?instance=.");
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

    // --- DTOs (named so they appear in the OpenAPI schema) ---
    public record InstanceDto(string Id, bool Primary, string? Host, int PollInterval, bool ActionsEnabled);
    public record HealthDto(DateTime StartedUtc, long UptimeSeconds, bool MqttConnected, DateTime? LastPollUtc);
    public record SnapshotDto(string InstanceId, DateTime TimestampUtc, double AgeSeconds);
    public record ReadingDto(string InstanceId, string Device, string Source, string Type, double Value, string Units);
}
