using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Core.Plans;
using rPDU2MQTT.Models.Config;

namespace rPDU2MQTT.Services.Gui;

/// <summary>Plan images (#462), kept in plan storage and referred to from the configuration by id.</summary>
public sealed partial class GuiService
{
    private PlanImages? planImages;
    private readonly IPlanImageStore? cachePlans;

    /// <summary>The plan image store, rebuilt when its settings change.</summary>
    private PlanImages Plans()
    {
        if (planImages is null || !ReferenceEquals(planStorageSeen, config.PlanStorage))
        {
            planImages = PlanImages.For(config.PlanStorage, cache: cachePlans);
            planStorageSeen = config.PlanStorage;
        }
        return planImages;
    }
    private PlanStorageConfig? planStorageSeen;

    private void MapPlanImageEndpoints(WebApplication app)
    {
        // Plan images (#462): kept in plan storage, referred to from config by id.
        app.MapGet("/api/plans/storage", (HttpContext ctx) =>
        {
            var images = Plans();
            // Persistent unless nothing was named: then images sit beside the program and go with its container.
            var persistent = !images.Fallback;
            return Results.Json(new
            {
                ok = true, where = images.Store.Describe, limits = images.Limits, maxBytes = images.MaxBytes, persistent,
                why = persistent ? null : "No plan storage is configured, so uploaded plan images are kept beside the program and are lost when it restarts or its container is replaced. Set PlanStorage.Directory to a persistent volume (on Kubernetes, floorPlans.persistence.enabled), an S3 bucket, or turn on the shared cache.",
                configWritable = configSource.CanWrite,
            }, ConfigSchema.Json);
        });

        app.MapPost("/api/plans/images", async (HttpContext ctx) =>
        {
            var images = Plans();
            try
            {
                var limit = ctx.Features.Get<IHttpMaxRequestBodySizeFeature>();
                if (limit is { IsReadOnly: false }) limit.MaxRequestBodySize = images.MaxBytes + 1;
                using var ms = new MemoryStream();
                var buffer = new byte[81920];
                int read;
                while ((read = await ctx.Request.Body.ReadAsync(buffer, ctx.RequestAborted)) > 0)
                {
                    ms.Write(buffer, 0, read);
                    if (ms.Length > images.MaxBytes)
                        throw new PlanImageRejected($"The image is over the {config.PlanStorage.MaxMegabytes} MB limit. Raise PlanStorage.MaxMegabytes, or upload a smaller image.");
                }
                var id = await images.SaveAsync(ms.ToArray(), ctx.RequestAborted);
                return Results.Json(new { ok = true, id, message = $"Stored in {images.Store.Describe}." }, ConfigSchema.Json);
            }
            catch (PlanImageRejected ex) { return Results.Json(new { ok = false, message = ex.Message }, ConfigSchema.Json); }
            catch (Exception ex) { return Results.Json(new { ok = false, message = $"Could not store the image in {images.Store.Describe}: {ex.Message}" }, ConfigSchema.Json); }
        });

        app.MapGet("/api/plans/images/{id}", async (string id, HttpContext ctx) =>
        {
            var image = await Plans().ReadAsync(id, ctx.RequestAborted);
            if (image is null) return Results.NotFound();
            // An SVG opened directly must not run script in this origin.
            ctx.Response.Headers["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
            ctx.Response.Headers["X-Content-Type-Options"] = "nosniff";
            ctx.Response.Headers["Cache-Control"] = "private, max-age=31536000, immutable";
            return Results.Bytes(image.Bytes, image.ContentType);
        });

        app.MapDelete("/api/plans/images/{id}", async (string id, HttpContext ctx) =>
        {
            // An image still named by the saved configuration stays; removing it would blank a floor someone else is looking at.
            var inUse = ConfigSchema.ToJson(config).Contains($"\"{id}\"", StringComparison.Ordinal);
            if (inUse) return Results.Json(new { ok = false, message = "The saved configuration still uses this image." }, ConfigSchema.Json);
            await Plans().DeleteAsync(id, ctx.RequestAborted);
            return Results.Json(new { ok = true }, ConfigSchema.Json);
        });
    }
}
