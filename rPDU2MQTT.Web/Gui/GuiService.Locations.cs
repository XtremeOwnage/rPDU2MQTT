using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Core.Plans;
using rPDU2MQTT.Models.Config;

namespace rPDU2MQTT.Services.Gui;

/// <summary>Floor plans (#470): the location tree and its totals, circuits, plan images, tag migration and Home Assistant areas.</summary>
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

    private Models.PDU.PduData MergedSnapshot()
    {
        var merged = new Models.PDU.PduData();
        foreach (var s in snapshots.All) merged.Devices.AddRange(s.Data.Devices);
        return merged;
    }

    /// <summary>Per-node values for a period of whole days, summed from history; a node missing any day is unknown.</summary>
    private async Task<Dictionary<string, double?>?> PeriodValuesAsync(IReadOnlyCollection<string> nodes, int days, CancellationToken ct)
    {
        if (!config.History.Enabled || history is null) return null;
        var zone = EnergyPeriod.Resolve(config.EnergyFlow.Aggregation.PeriodTimeZone);
        var ends = EnergyPeriod.RecentPeriodEnds(DateTime.UtcNow, zone, config.EnergyFlow.Aggregation.PeriodStartHour, days);
        var rows = await history.SeriesAsync(nodes, EnergyPeriod.Metric, ends.Select(e => e.AtUtc).ToList(), ct);
        var sums = new Dictionary<string, double?>(StringComparer.OrdinalIgnoreCase);
        foreach (var n in nodes)
        {
            double total = 0;
            var known = rows.Count > 0;
            foreach (var row in rows)
                if (row.TryGetValue(n, out var v)) total += v; else { known = false; break; }
            sums[n] = known ? total : null;
        }
        return sums;
    }

    /// <summary>The location tree with each place's total, every circuit, and every placement — what the floor plan page draws.</summary>
    private async Task<object> LocationsPayloadAsync(EnergyFlowConfig flow, string metric, string? period, CancellationToken ct)
    {
        var data = MergedSnapshot();
        var index = LocationIndex.For(flow);
        var topology = FlowTopology.For(data, flow);
        var graph = FlowGraphBuilder.Build(data, flow, metric, live);
        var powerOf = LocationExport.ValuesOf(graph);

        Func<string, double?> valueOf = powerOf;
        var units = graph.Units is { Length: > 0 } u ? u : FlowUnits.Canonical(metric);
        string? periodNote = null;
        if (period == "today")
        {
            var today = FlowGraphBuilder.Build(data, flow, EnergyPeriod.Metric, live);
            valueOf = LocationExport.ValuesOf(today);
            units = FlowUnits.Canonical(EnergyPeriod.Metric);
        }
        else if (period == "week")
        {
            var sums = await PeriodValuesAsync(topology.Nodes.ToList(), 7, ct);
            if (sums is null) periodNote = "History is not enabled, so there is no week to total. Turn it on under Features.";
            valueOf = id => sums is not null && sums.TryGetValue(id, out var v) ? v : null;
            units = FlowUnits.Canonical(EnergyPeriod.Metric);
        }

        var totals = LocationRollup.Compute(index, topology, valueOf);
        var placed = LocationRollup.Placed(index, topology);
        var labels = graph.Nodes.ToDictionary(n => n.Id, n => n.Label, StringComparer.OrdinalIgnoreCase);
        string Label(string id) => labels.TryGetValue(id, out var l) ? l : id;

        var circuits = Circuits.Report(flow, live, powerOf, topology, metric);
        return new
        {
            ok = true,
            metric,
            period,
            units,
            message = periodNote,
            problems = index.Problems,
            places = index.All.Select(e =>
            {
                var t = totals[e.Id];
                return new
                {
                    id = e.Id,
                    name = e.Label,
                    kind = e.Kind,
                    site = e.Site.Id,
                    floor = e.Floor?.Id,
                    value = t.Value,
                    state = t.State,
                    nodes = t.Nodes.Select(n => new { id = n, label = Label(n) }).ToArray(),
                    missing = t.Missing.Select(n => new { id = n, label = Label(n) }).ToArray(),
                    split = t.Split.Select(n => new { id = n, label = Label(n) }).ToArray(),
                };
            }).ToArray(),
            nodes = graph.Nodes.Where(n => !n.Synthetic).Select(n => new
            {
                id = n.Id,
                label = n.Label,
                kind = n.Kind,
                value = n.Value,
                location = index.LocationOf(n.Id),
                placed = placed.GetValueOrDefault(n.Id),
                circuit = flow.Nodes.FirstOrDefault(c => string.Equals(c.Id, n.Id, StringComparison.OrdinalIgnoreCase))?.Circuit,
            }).OrderBy(n => n.label, StringComparer.OrdinalIgnoreCase).ToArray(),
            circuits = circuits.Select(c => new
            {
                @ref = c.Ref,
                panel = c.Chain.Panel.Id,
                panelName = string.IsNullOrWhiteSpace(c.Chain.Panel.Name) ? c.Chain.Panel.Id : c.Chain.Panel.Name,
                number = c.Chain.Breaker.Number,
                description = c.Chain.Breaker.Description,
                amps = c.Chain.Breaker.Amps,
                state = BreakerState.Of(c.Chain.Breaker.State),
                node = c.Node,
                channels = c.Chain.Legs.Select(l => l.Channel).Where(ch => ch is not null).ToArray(),
                power = c.Power,
                gap = c.Gap.ToString().ToLowerInvariant(),
                devices = c.Devices.Select(d => new { node = d.Node, label = Label(d.Node), value = d.Value }).ToArray(),
                remainder = c.Remainder,
                remainderState = c.State.ToString().ToLowerInvariant(),
                exceeded = c.Exceeded,
                rooms = c.Rooms,
                placements = c.Placements.Select(p => p.Id).ToArray(),
            }).ToArray(),
            placements = (flow.Placements ?? new()).Select(p => new
            {
                id = p.Id,
                value = string.IsNullOrWhiteSpace(p.Node) ? null : powerOf(p.Node),
                circuitKnown = Circuits.Find(PanelMap.For(flow), p.Circuit) is not null,
            }).ToArray(),
        };
    }

    private static string LocationMetric(HttpContext ctx) =>
        string.IsNullOrWhiteSpace(ctx.Request.Query["metric"]) ? FlowGraphBuilder.DefaultMetric : ctx.Request.Query["metric"].ToString();

    private static string? LocationPeriod(HttpContext ctx) =>
        ctx.Request.Query["period"].ToString() is "today" or "week" ? ctx.Request.Query["period"].ToString() : null;

    private async Task<Config> PostedConfig(HttpContext ctx)
    {
        using var reader = new StreamReader(ctx.Request.Body);
        var json = await reader.ReadToEndAsync(ctx.RequestAborted);
        return string.IsNullOrWhiteSpace(json) ? config : ConfigSchema.FromJson(json);
    }

    private void MapLocationEndpoints(WebApplication app)
    {
        app.MapGet("/api/locations", async (HttpContext ctx) =>
        {
            try { return Results.Json(await LocationsPayloadAsync(config.EnergyFlow, LocationMetric(ctx), LocationPeriod(ctx), ctx.RequestAborted), ConfigSchema.Json); }
            catch (Exception ex) { return Results.Json(new { ok = false, message = ex.Message }, ConfigSchema.Json); }
        });

        // The locations as they are on screen, before Save, so a room drawn or a device placed is totalled at once.
        app.MapPost("/api/locations/resolve", async (HttpContext ctx) =>
        {
            try
            {
                var posted = await PostedConfig(ctx);
                return Results.Json(await LocationsPayloadAsync(posted.EnergyFlow ?? config.EnergyFlow, LocationMetric(ctx), LocationPeriod(ctx), ctx.RequestAborted), ConfigSchema.Json);
            }
            catch (Exception ex) { return Results.Json(new { ok = false, message = ex.Message }, ConfigSchema.Json); }
        });

        // One place's total through a window, from history: the same rollup at every instant.
        app.MapPost("/api/locations/series", async (HttpContext ctx) =>
        {
            try
            {
                if (!config.History.Enabled || history is null)
                    return Results.Json(new { ok = false, message = "History is not enabled. Turn it on under Features to chart a room." }, ConfigSchema.Json);
                var posted = await PostedConfig(ctx);
                var flow = posted.EnergyFlow ?? config.EnergyFlow;
                var place = ctx.Request.Query["location"].ToString();
                var index = LocationIndex.For(flow);
                if (!index.Contains(place)) return Results.Json(new { ok = false, message = $"There is no place '{place}'." }, ConfigSchema.Json);

                var topology = FlowTopology.For(MergedSnapshot(), flow);
                var inside = LocationRollup.Placed(index, topology).Where(kv => index.Within(kv.Value, place)).Select(kv => kv.Key)
                    .ToHashSet(StringComparer.OrdinalIgnoreCase);
                if (inside.Count == 0) return Results.Json(new { ok = false, message = "Nothing metered is in this place, so there is nothing to chart." }, ConfigSchema.Json);

                var minutes = int.TryParse(ctx.Request.Query["minutes"].ToString(), out var m) ? Math.Clamp(m, 5, SeriesWindow.MaxMinutes) : 1440;
                var step = SeriesWindow.ClampStep(int.TryParse(ctx.Request.Query["step"].ToString(), out var st) ? st : null, 300);
                var end = DateTime.UtcNow;
                var when = SeriesWindow.Instants(end - TimeSpan.FromMinutes(minutes), end, step);
                var ids = inside.Concat(inside.SelectMany(n => topology.Children(n))).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
                var rows = await history.SeriesAsync(ids, FlowGraphBuilder.DefaultMetric, when, ctx.RequestAborted);
                var values = rows.Select(row => LocationRollup.Total(place, inside, topology, id => row.TryGetValue(id, out var v) ? v : null).Value).ToList();
                return Results.Json(new
                {
                    ok = true,
                    location = place,
                    units = FlowUnits.Canonical(FlowGraphBuilder.DefaultMetric),
                    at = when.Select(w => DateTime.SpecifyKind(w, DateTimeKind.Utc)).ToList(),
                    values,
                }, ConfigSchema.Json);
            }
            catch (Exception ex) { return Results.Json(new { ok = false, message = ex.Message }, ConfigSchema.Json); }
        });

        // Room and area tags: every tag in use with what it looks like, and — given mappings — the plan (#461).
        app.MapPost("/api/locations/migrate", async (HttpContext ctx) =>
        {
            try
            {
                var body = await System.Text.Json.JsonDocument.ParseAsync(ctx.Request.Body, cancellationToken: ctx.RequestAborted);
                var flow = body.RootElement.TryGetProperty("config", out var c)
                    ? ConfigSchema.FromJson(c.GetRawText()).EnergyFlow ?? config.EnergyFlow
                    : config.EnergyFlow;
                var mappings = body.RootElement.TryGetProperty("mappings", out var mp)
                    ? System.Text.Json.JsonSerializer.Deserialize<List<TagMapping>>(mp.GetRawText(), new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web)) ?? new()
                    : new();
                var tags = LocationMigration.TagsInUse(flow).Select(t => new { tag = t.Tag, count = t.Count, suggest = LocationMigration.Suggest(t.Tag), id = LocationMigration.IdFor(t.Tag), name = LocationMigration.NameFor(t.Tag) });
                return Results.Json(new { ok = true, tags, plan = LocationMigration.Plan(flow, mappings) }, ConfigSchema.Json);
            }
            catch (Exception ex) { return Results.Json(new { ok = false, message = ex.Message }, ConfigSchema.Json); }
        });

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
            var inUse = (config.EnergyFlow.Sites ?? new()).SelectMany(s => s.Floors ?? new()).Any(f => f.Image == id);
            if (inUse) return Results.Json(new { ok = false, message = "The saved configuration still uses this image." }, ConfigSchema.Json);
            await Plans().DeleteAsync(id, ctx.RequestAborted);
            return Results.Json(new { ok = true }, ConfigSchema.Json);
        });

        // Rooms as Home Assistant areas (#467): what would change, then the change.
        app.MapPost("/api/ha/areas/preview", async (HttpContext ctx) =>
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ctx.RequestAborted);
            cts.CancelAfter(TimeSpan.FromSeconds(20));
            try
            {
                var posted = await PostedConfig(ctx);
                var plan = await haEnergy.PlanAreasAsync(posted.EnergyFlow ?? config.EnergyFlow, config.HASS.EnergyDashboard.Url ?? "", config.HASS.EnergyDashboard.Token ?? "", cts.Token);
                return Results.Json(new { ok = true, plan }, ConfigSchema.Json);
            }
            catch (Exception ex) { return Results.Json(new { ok = false, message = $"Could not read Home Assistant: {ex.Message}" }, ConfigSchema.Json); }
        });

        app.MapPost("/api/ha/areas/apply", async (HttpContext ctx) =>
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ctx.RequestAborted);
            cts.CancelAfter(TimeSpan.FromSeconds(60));
            try
            {
                var posted = await PostedConfig(ctx);
                var (plan, linked, failed) = await haEnergy.ApplyAreasAsync(posted.EnergyFlow ?? config.EnergyFlow, config.HASS.EnergyDashboard.Url ?? "", config.HASS.EnergyDashboard.Token ?? "", cts.Token);
                return Results.Json(new { ok = failed.Count == 0, plan, linked, failed,
                    message = failed.Count == 0 ? $"Published {linked.Count} room(s) as areas." : $"{failed.Count} change(s) failed: {string.Join("; ", failed)}" }, ConfigSchema.Json);
            }
            catch (Exception ex) { return Results.Json(new { ok = false, message = $"Could not update Home Assistant: {ex.Message}" }, ConfigSchema.Json); }
        });
    }
}
