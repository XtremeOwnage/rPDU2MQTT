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
