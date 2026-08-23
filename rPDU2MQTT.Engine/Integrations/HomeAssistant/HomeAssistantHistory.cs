using System.Globalization;
using System.Text.Json;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Flow;

namespace rPDU2MQTT.Integrations.HomeAssistant;

/// <summary>
/// Past values from Home Assistant's recorder — a third history backend beside Prometheus and EmonCMS.
///
/// <para>
/// It is the backend a lot of homes already have without deciding to: HA has been recording every entity
/// this bridge publishes since discovery was switched on, so "what did the inverter read on Tuesday" is
/// already answerable without standing up a time-series database for it.
/// </para>
/// <para>
/// A node is matched to an entity by the unique_id this bridge publishes discovery under, which is what
/// makes the lookup exact rather than a guess at a friendly name someone has since renamed.
/// </para>
/// </summary>
public sealed class HomeAssistantHistory : IMeasurementHistory
{
    private readonly HttpClient http;
    private readonly Config cfg;

    public HomeAssistantHistory(HttpClient http, Config cfg)
    {
        this.http = http;
        this.cfg = cfg;
    }

    public string Id => "homeassistant";

    public async Task<(bool Ok, string Detail)> ProbeAsync(CancellationToken ct)
    {
        var ed = cfg.HASS.EnergyDashboard;
        if (string.IsNullOrWhiteSpace(ed.Url)) return (false, "no Home Assistant URL set");
        if (string.IsNullOrWhiteSpace(ed.Token)) return (false, "no long-lived access token set");

        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, $"{ed.Url!.TrimEnd('/')}/api/");
            request.Headers.Authorization = new("Bearer", ed.Token);
            var response = await http.SendAsync(request, ct);
            return response.IsSuccessStatusCode
                ? (true, ed.Url!)
                : (false, $"{ed.Url} answered {(int)response.StatusCode}");
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            return (false, $"{ed.Url}: no answer within {http.Timeout.TotalSeconds:0}s");
        }
        catch (Exception ex) { return (false, $"{ed.Url}: {ex.Message}"); }
    }

    public async Task<IReadOnlyDictionary<string, double>> ValuesAtAsync(
        IReadOnlyCollection<string> nodeIds, string metric, DateTime atUtc, CancellationToken ct)
    {
        var found = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);
        var ed = cfg.HASS.EnergyDashboard;
        if (string.IsNullOrWhiteSpace(ed.Url) || string.IsNullOrWhiteSpace(ed.Token) || nodeIds.Count == 0)
            return found;

        // The entity each node publishes under, so the lookup is exact rather than a guess at a display
        // name someone has since renamed in Home Assistant.
        var entityOf = nodeIds.ToDictionary(
            id => EntityFor(id, metric),
            id => id,
            StringComparer.OrdinalIgnoreCase);

        // One request for the whole set: HA takes a comma-separated filter, and a request per node is what
        // made the EmonCMS reader slow enough to notice on a hierarchy of any size.
        var from = atUtc.AddMinutes(-Math.Max(1, cfg.History.ToleranceSeconds / 60.0)).ToString("o", CultureInfo.InvariantCulture);
        var url = $"{ed.Url!.TrimEnd('/')}/api/history/period/{Uri.EscapeDataString(from)}"
                + $"?filter_entity_id={Uri.EscapeDataString(string.Join(',', entityOf.Keys))}"
                + $"&end_time={Uri.EscapeDataString(atUtc.ToString("o", CultureInfo.InvariantCulture))}"
                + "&minimal_response&no_attributes";

        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            request.Headers.Authorization = new("Bearer", ed.Token);
            var response = await http.SendAsync(request, ct);
            if (!response.IsSuccessStatusCode)
            {
                Log.Warning($"Flow history: Home Assistant answered {(int)response.StatusCode} for {entityOf.Count} entity/entities at {atUtc:u}.");
                return found;
            }

            using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
            if (doc.RootElement.ValueKind != JsonValueKind.Array) return found;

            // The shape is a list per entity, oldest first; the last point at or before the instant is the
            // answer. A non-numeric state ("unavailable") is a gap, not a zero.
            foreach (var series in doc.RootElement.EnumerateArray())
            {
                if (series.ValueKind != JsonValueKind.Array || series.GetArrayLength() == 0) continue;

                var entity = series[0].TryGetProperty("entity_id", out var e) ? e.GetString() : null;
                if (entity is null || !entityOf.TryGetValue(entity, out var node)) continue;

                foreach (var point in series.EnumerateArray())
                    if (point.TryGetProperty("state", out var st)
                        && double.TryParse(st.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var v)
                        && double.IsFinite(v))
                        found[node] = v;   // later points overwrite earlier ones: the last wins
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            Log.Warning($"Flow history: could not reach Home Assistant at {ed.Url} ({ex.Message}).");
        }
        return found;
    }

    /// <summary>
    /// The whole window in one request, rather than the interface's default of one request per instant.
    ///
    /// <para>
    /// That default calls <see cref="ValuesAtAsync"/> once per step, so a day of five-minute steps was 289
    /// requests to Home Assistant for one chart. The Trends page caps a series build at 60 seconds, which
    /// is what the operator would meet first: not a slow chart, but no history.
    /// </para>
    /// <para>
    /// The history endpoint already takes a range and a set of entities, so the whole thing is one call.
    /// Each step takes the last state at or before it — a reading holds until the next one — and a
    /// non-numeric state ("unavailable") is a gap rather than a zero.
    /// </para>
    /// </summary>
    public async Task<IReadOnlyList<IReadOnlyDictionary<string, double>>> SeriesAsync(
        IReadOnlyCollection<string> nodeIds, string metric, IReadOnlyList<DateTime> steps, CancellationToken ct)
    {
        var perStep = steps.Select(_ => new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase)).ToList();
        var result = perStep.Cast<IReadOnlyDictionary<string, double>>().ToList();

        var ed = cfg.HASS.EnergyDashboard;
        if (string.IsNullOrWhiteSpace(ed.Url) || string.IsNullOrWhiteSpace(ed.Token) || nodeIds.Count == 0 || steps.Count == 0)
            return result;

        var entityOf = nodeIds.ToDictionary(id => EntityFor(id, metric), id => id, StringComparer.OrdinalIgnoreCase);
        var ordered = steps.Select(s => DateTime.SpecifyKind(s, DateTimeKind.Utc)).ToList();

        // One interval before the first step: a step takes the last state at or before it, and the state
        // that answers the first one was usually set before the window began.
        var span = ordered.Count > 1 ? ordered[^1] - ordered[0] : TimeSpan.FromSeconds(Math.Max(1, cfg.History.ToleranceSeconds));
        var lead = ordered.Count > 1 ? TimeSpan.FromTicks(span.Ticks / (ordered.Count - 1)) : span;
        var from = ordered.Min() - lead;
        var to = ordered.Max();

        var url = $"{ed.Url!.TrimEnd('/')}/api/history/period/{Uri.EscapeDataString(from.ToString("o", CultureInfo.InvariantCulture))}"
                + $"?filter_entity_id={Uri.EscapeDataString(string.Join(',', entityOf.Keys))}"
                + $"&end_time={Uri.EscapeDataString(to.ToString("o", CultureInfo.InvariantCulture))}"
                + "&minimal_response&no_attributes";

        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            request.Headers.Authorization = new("Bearer", ed.Token);
            var response = await http.SendAsync(request, ct);
            if (!response.IsSuccessStatusCode)
            {
                Log.Warning($"Flow history: Home Assistant answered {(int)response.StatusCode} for {entityOf.Count} entity/entities over {steps.Count} step(s).");
                return result;
            }

            using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
            if (doc.RootElement.ValueKind != JsonValueKind.Array) return result;

            foreach (var series in doc.RootElement.EnumerateArray())
            {
                if (series.ValueKind != JsonValueKind.Array || series.GetArrayLength() == 0) continue;
                var entity = series[0].TryGetProperty("entity_id", out var e) ? e.GetString() : null;
                if (entity is null || !entityOf.TryGetValue(entity, out var node)) continue;

                var points = new List<(DateTime At, double Value)>();
                foreach (var point in series.EnumerateArray())
                {
                    if (!point.TryGetProperty("state", out var st)
                        || !double.TryParse(st.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var v)
                        || !double.IsFinite(v)) continue;
                    var when = point.TryGetProperty("last_changed", out var lc) ? lc.GetString()
                             : point.TryGetProperty("last_updated", out var lu) ? lu.GetString() : null;
                    if (!DateTime.TryParse(when, CultureInfo.InvariantCulture,
                            DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var ts)) continue;
                    points.Add((ts, v));
                }
                if (points.Count == 0) continue;
                points.Sort((a, b) => a.At.CompareTo(b.At));

                // Both walked once, in time order, rather than searching the points per step.
                var order = Enumerable.Range(0, ordered.Count).OrderBy(i => ordered[i]).ToList();
                var cursor = 0;
                double? held = null;
                foreach (var i in order)
                {
                    while (cursor < points.Count && points[cursor].At <= ordered[i]) held = points[cursor++].Value;
                    if (held is { } h) perStep[i][node] = h;
                }
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            Log.Warning($"Flow history: could not reach Home Assistant at {ed.Url} ({ex.Message}).");
        }
        return result;
    }

    /// <summary>
    /// The entity a node's value is recorded under — the same unique_id the discovery export publishes, so
    /// the two cannot drift.
    /// </summary>
    private static string EntityFor(string nodeId, string metric)
    {
        var uid = string.Equals(metric, EnergyPeriod.Metric, StringComparison.OrdinalIgnoreCase)
            ? FlowExport.DeviceId(nodeId) + "_energy_today"
            : metric.StartsWith("energy", StringComparison.OrdinalIgnoreCase)
                ? FlowExport.EnergyUniqueId(nodeId)
                : FlowExport.PowerUniqueId(nodeId);
        return "sensor." + uid;
    }
}
