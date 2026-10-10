using System.Text.Json;
using rPDU2MQTT.Models.PDU;
using rPDU2MQTT.Services.Gui;

namespace rPDU2MQTT.Plugin.Locations;

/// <summary>What the Floor Plans page asks for: totals per place, a place's history, tags to rooms, and rooms as Home Assistant areas.</summary>
internal sealed class LocationEndpoints(IPluginHost host)
{
    private PduData Merged()
    {
        var merged = new PduData();
        foreach (var s in host.Snapshots.All) merged.Devices.AddRange(s.Data.Devices);
        return merged;
    }

    /// <summary>Per-node values for a period of whole days, summed from history; a node missing any day is unknown.</summary>
    private async Task<Dictionary<string, double?>?> PeriodValuesAsync(Config cfg, IReadOnlyCollection<string> nodes, int days, CancellationToken ct)
    {
        if (host.History is not { } history) return null;
        var zone = EnergyPeriod.Resolve(cfg.EnergyFlow.Aggregation.PeriodTimeZone);
        var ends = EnergyPeriod.RecentPeriodEnds(DateTime.UtcNow, zone, cfg.EnergyFlow.Aggregation.PeriodStartHour, days);
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
    public async Task<object> TotalsAsync(Config cfg, string metric, string? period, CancellationToken ct)
    {
        var flow = cfg.EnergyFlow;
        var settings = LocationSettings.Of(cfg);
        var live = host.LiveValues;
        var data = Merged();
        var index = LocationIndex.For(settings, flow);
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
            var sums = await PeriodValuesAsync(cfg, topology.Nodes.ToList(), 7, ct);
            if (sums is null) periodNote = "History is not enabled, so there is no week to total. Turn it on under Features.";
            valueOf = id => sums is not null && sums.TryGetValue(id, out var v) ? v : null;
            units = FlowUnits.Canonical(EnergyPeriod.Metric);
        }

        var totals = LocationRollup.Compute(index, topology, valueOf);
        var placed = LocationRollup.Placed(index, topology);
        var labels = graph.Nodes.ToDictionary(n => n.Id, n => n.Label, StringComparer.OrdinalIgnoreCase);
        string Label(string id) => labels.TryGetValue(id, out var l) ? l : id;

        var placements = settings.Placements ?? new();
        var circuits = Circuits.Report(flow, live, powerOf, topology, metric, placements.Select(p => (p.Node, p.Circuit)));
        bool On(string? circuit, CircuitReport c) => Circuits.Parse(circuit) is { } p
            && string.Equals(p.Panel, c.Chain.Panel.Id, StringComparison.OrdinalIgnoreCase)
            && string.Equals(p.Breaker, c.Chain.Breaker.Number, StringComparison.OrdinalIgnoreCase);
        var map = PanelMap.For(flow);
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
                rooms = LocationIndex.ServedRooms(c.Chain.Breaker),
                placements = placements.Where(p => On(p.Circuit, c)).Select(p => p.Id).ToArray(),
            }).ToArray(),
            placements = placements.Select(p => new
            {
                id = p.Id,
                value = string.IsNullOrWhiteSpace(p.Node) ? null : powerOf(p.Node),
                circuitKnown = Circuits.Find(map, p.Circuit) is not null,
            }).ToArray(),
        };
    }

    /// <summary>One place's total through a window, from history: the same rollup at every instant.</summary>
    public async Task<object> SeriesAsync(Config cfg, string place, int minutes, string? step, CancellationToken ct)
    {
        if (host.History is not { } history)
            return new { ok = false, message = "History is not enabled. Turn it on under Features to chart a room." };
        var flow = cfg.EnergyFlow;
        var index = LocationIndex.For(cfg);
        if (!index.Contains(place)) return new { ok = false, message = $"There is no place '{place}'." };

        var topology = FlowTopology.For(Merged(), flow);
        var inside = LocationRollup.Placed(index, topology).Where(kv => index.Within(kv.Value, place)).Select(kv => kv.Key)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        if (inside.Count == 0) return new { ok = false, message = "Nothing metered is in this place, so there is nothing to chart." };

        minutes = Math.Clamp(minutes, 5, SeriesWindow.MaxMinutes);
        var seconds = SeriesWindow.ClampStep(int.TryParse(step, out var st) ? st : null, 300);
        var end = DateTime.UtcNow;
        var when = SeriesWindow.Instants(end - TimeSpan.FromMinutes(minutes), end, seconds);
        var ids = inside.Concat(inside.SelectMany(n => topology.Children(n))).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        var rows = await history.SeriesAsync(ids, FlowGraphBuilder.DefaultMetric, when, ct);
        var values = rows.Select(row => LocationRollup.Total(place, inside, topology, id => row.TryGetValue(id, out var v) ? v : null).Value).ToList();
        return new
        {
            ok = true,
            location = place,
            units = FlowUnits.Canonical(FlowGraphBuilder.DefaultMetric),
            at = when.Select(w => DateTime.SpecifyKind(w, DateTimeKind.Utc)).ToList(),
            values,
        };
    }

    /// <summary>Room and area tags: every tag in use with what it looks like, and — given mappings — the plan (#461).</summary>
    public object Migrate(string? body)
    {
        var cfg = host.Config;
        var mappings = new List<TagMapping>();
        if (!string.IsNullOrWhiteSpace(body))
        {
            using var doc = JsonDocument.Parse(body);
            if (doc.RootElement.TryGetProperty("config", out var c)) cfg = ConfigSchema.FromJson(c.GetRawText());
            if (doc.RootElement.TryGetProperty("mappings", out var mp))
                mappings = JsonSerializer.Deserialize<List<TagMapping>>(mp.GetRawText(), new JsonSerializerOptions(JsonSerializerDefaults.Web)) ?? new();
        }
        var flow = cfg.EnergyFlow;
        var tags = LocationMigration.TagsInUse(flow).Select(t => new { tag = t.Tag, count = t.Count, suggest = LocationMigration.Suggest(t.Tag), id = LocationMigration.IdFor(t.Tag), name = LocationMigration.NameFor(t.Tag) });
        return new { ok = true, tags, plan = LocationMigration.Plan(LocationSettings.Of(cfg), flow, mappings) };
    }

    /// <summary>Rooms as Home Assistant areas (#467): what would change, or the change.</summary>
    public async Task<object> AreasAsync(Config cfg, bool apply, CancellationToken ct)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(TimeSpan.FromSeconds(apply ? 60 : 20));
        try
        {
            using var session = await HomeAssistantSocket.OpenAsync(host.Config.HASS.Url, host.Config.HASS.Token, cts.Token);
            var sync = new HaAreaSync(session);
            var index = LocationIndex.For(cfg);
            var deviceRooms = HaAreaSync.DeviceRooms(index, Merged(), cfg.EnergyFlow);
            if (!apply) return new { ok = true, plan = await sync.PlanAsync(index, deviceRooms) };

            var (plan, linked, failed) = await sync.ApplyAsync(index, deviceRooms);
            return new
            {
                ok = failed.Count == 0, plan, linked, failed,
                message = failed.Count == 0 ? $"Published {linked.Count} room(s) as areas." : $"{failed.Count} change(s) failed: {string.Join("; ", failed)}",
            };
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            return new { ok = false, message = apply ? $"Could not update Home Assistant: {ex.Message}" : $"Could not read Home Assistant: {ex.Message}" };
        }
    }
}
