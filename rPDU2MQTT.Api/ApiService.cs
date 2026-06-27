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

        // --- Write/control (opt-in: requires Api.ApiKey set + a matching X-Api-Key header) ---

        v1.MapPost("/instances/{id}/outlets/{deviceId}/{index:int}/control", async (string id, string deviceId, int index, ControlBody body, HttpContext ctx) =>
        {
            if (Unauthorized(ctx) is { } authError) return authError;
            if (Resolve(id, out var pdu, out var notFound) is false) return notFound!;
            var action = (body.Action ?? "").Trim().ToLowerInvariant();
            if (action is not ("on" or "off" or "reboot" or "resetstats"))
                return Results.BadRequest(new { ok = false, message = "action must be on, off, reboot or resetstats." });

            if (action == "resetstats")
                await pdu!.ResetOutletStatsAsync(deviceId, index, ctx.RequestAborted);
            else
                await pdu!.ControlOutletAsync(deviceId, index, action, ctx.RequestAborted);
            return Results.Ok(new { ok = true, message = $"Outlet {index + 1} on '{id}' -> {action}." });
        }).WithName("ControlOutlet").WithSummary("Control an outlet (on/off/reboot/resetStats). Requires Api.ApiKey + ActionsEnabled.");

        v1.MapPost("/instances/{id}/groups/{groupKey}/control", async (string id, string groupKey, ControlBody body, HttpContext ctx) =>
        {
            if (Unauthorized(ctx) is { } authError) return authError;
            if (Resolve(id, out var pdu, out var notFound) is false) return notFound!;
            var action = (body.Action ?? "").Trim().ToLowerInvariant();
            if (action is not ("on" or "off" or "reboot"))
                return Results.BadRequest(new { ok = false, message = "action must be on, off or reboot." });

            var n = await pdu!.ControlGroupAsync(groupKey, action, ctx.RequestAborted);
            return Results.Ok(new { ok = true, message = $"Group '{groupKey}' on '{id}' -> {action} ({n} outlet(s))." });
        }).WithName("ControlGroup").WithSummary("Control every outlet in a group (on/off/reboot). Requires Api.ApiKey + ActionsEnabled.");
    }

    // Validate the instance exists (no silent fall-back to primary) and has write actions enabled.
    private bool Resolve(string id, out PDU? pdu, out IResult? error)
    {
        pdu = null;
        error = null;
        if (!registry.All.ContainsKey(id))
        {
            error = Results.NotFound(new { ok = false, message = $"Unknown PDU instance '{id}'." });
            return false;
        }
        if (!(cfg.Pdus.TryGetValue(id, out var c) && c.ActionsEnabled))
        {
            error = Results.Json(new { ok = false, message = $"Write actions are disabled for instance '{id}' (ActionsEnabled is false)." }, statusCode: StatusCodes.Status409Conflict);
            return false;
        }
        pdu = registry.Get(id);
        return true;
    }

    // Returns an error result when the request may not write (no key configured, or wrong/missing key); null when allowed.
    private IResult? Unauthorized(HttpContext ctx)
    {
        if (string.IsNullOrEmpty(cfg.Api.ApiKey))
            return Results.Json(new { ok = false, message = "Write endpoints are disabled. Set Api.ApiKey to enable control via the API." }, statusCode: StatusCodes.Status403Forbidden);

        var provided = ctx.Request.Headers["X-Api-Key"].ToString();
        var a = System.Text.Encoding.UTF8.GetBytes(provided);
        var b = System.Text.Encoding.UTF8.GetBytes(cfg.Api.ApiKey);
        if (a.Length != b.Length || !System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(a, b))
            return Results.Json(new { ok = false, message = "Missing or invalid X-Api-Key." }, statusCode: StatusCodes.Status401Unauthorized);

        return null;
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
    public record ControlBody(string Action);
}
