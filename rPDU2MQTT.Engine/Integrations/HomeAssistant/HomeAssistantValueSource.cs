using System.Text.Json;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Core.Integrations;

namespace rPDU2MQTT.Integrations.HomeAssistant;

/// <summary>
/// Home Assistant read the other way round: a flow node valued from an HA entity's state.
///
/// <para>
/// This bridge normally tells Home Assistant things. Plenty of homes have the opposite problem — the meter,
/// the inverter or the smart plug that measures a circuit is already in HA through some other integration,
/// and getting it into the energy hierarchy meant re-plumbing it to MQTT. Binding <c>Type: homeassistant</c>
/// with the entity id reads it directly.
/// </para>
/// <para>
/// Polled rather than subscribed: HA's REST API is a fetch, and a poll on the flow's own cadence is both
/// simpler and enough for values that feed a roll-up. An entity that is unavailable or non-numeric is
/// reported as nothing, never as zero — "unavailable" is HA saying it does not know, and a zero would be
/// this bridge claiming it does.
/// </para>
/// </summary>
public sealed class HomeAssistantValueSource : IIntegration, IValueSourcePlugin, IStatusProvider
{
    private static readonly HttpClient http = new() { Timeout = TimeSpan.FromSeconds(10) };
    private readonly Config cfg;

    // node|metric -> value, refreshed by ReconcileAsync's own poll.
    private readonly Dictionary<string, double> values = new(StringComparer.OrdinalIgnoreCase);
    private IReadOnlyList<SourceBinding> bindings = [];
    private DateTime lastFetch = DateTime.MinValue;
    private string? lastError;

    public HomeAssistantValueSource(Config cfg) => this.cfg = cfg;

    public string Id => "homeassistant-source";
    public string DisplayName => "Home Assistant entities";
    public IntegrationGroup Group => IntegrationGroup.Integrations;

    public string SourceType => "homeassistant";
    public string SourceTypeLabel => "Home Assistant entity";

    /// <summary>On when something is actually bound to it — this costs a request per poll, so it does not
    /// run because Home Assistant happens to be configured for something else.</summary>
    public bool Enabled(Config c) => SourceBindings.For(c, SourceType).Count > 0;

    public string? Misconfigured(Config c)
    {
        if (!Enabled(c)) return null;
        var ed = c.HASS.EnergyDashboard;
        return string.IsNullOrWhiteSpace(ed.Url) || string.IsNullOrWhiteSpace(ed.Token)
            ? "Nodes are bound to Home Assistant entities, but HomeAssistant.EnergyDashboard.Url and a "
              + "long-lived access token are needed to read them."
            : null;
    }

    public IntegrationHealth Status(Config c)
    {
        if (!Enabled(c)) return new(HealthLevel.Off, "No entities bound");
        if (Misconfigured(c) is { } fault) return new(HealthLevel.Bad, "Misconfigured", fault);
        if (lastError is not null) return new(HealthLevel.Bad, "Cannot read", lastError);
        return lastFetch == DateTime.MinValue
            ? new(HealthLevel.Warn, "No data yet", $"{bindings.Count} entity binding(s)")
            : new(HealthLevel.Good, "Reading", $"{values.Count} of {bindings.Count} entity binding(s)");
    }

    public async Task ReconcileAsync(Config c, IReadOnlyList<SourceBinding> bound, CancellationToken ct)
    {
        bindings = bound;
        await FetchAsync(ct);
    }

    public bool TryGetValue(string nodeId, string metric, out double value)
        => values.TryGetValue(nodeId + "|" + metric, out value);

    /// <summary>Read every bound entity's current state. Public so a test can drive it.</summary>
    public async Task FetchAsync(CancellationToken ct)
    {
        var ed = cfg.HASS.EnergyDashboard;
        if (Misconfigured(cfg) is not null) return;

        var fetched = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);
        string? error = null;

        foreach (var binding in bindings)
        {
            // The entity id is the binding's address: Topic for a legacy-shaped binding, else Settings.
            var entity = binding.Setting("Entity") ?? binding.Source.Topic;
            if (string.IsNullOrWhiteSpace(entity)) continue;

            try
            {
                using var request = new HttpRequestMessage(HttpMethod.Get,
                    $"{ed.Url!.TrimEnd('/')}/api/states/{Uri.EscapeDataString(entity)}");
                request.Headers.Authorization = new("Bearer", ed.Token);

                var response = await http.SendAsync(request, ct);
                if (!response.IsSuccessStatusCode)
                {
                    error ??= $"{entity}: HTTP {(int)response.StatusCode}";
                    continue;
                }

                using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
                var state = doc.RootElement.TryGetProperty("state", out var st) ? st.GetString() : null;

                // "unavailable"/"unknown" is Home Assistant saying it does not know. Recording 0 would be
                // this bridge saying it does, and that number would roll up through the whole hierarchy.
                if (!double.TryParse(state, System.Globalization.NumberStyles.Any,
                        System.Globalization.CultureInfo.InvariantCulture, out var value))
                    continue;

                var unit = doc.RootElement.TryGetProperty("attributes", out var attrs)
                           && attrs.TryGetProperty("unit_of_measurement", out var u) ? u.GetString() : null;

                // Converted to the metric's canonical unit on the way in, as every other ingest does, so a
                // W and a kW entity roll up together instead of differing by a thousand.
                var metric = binding.Source.Metric ?? "";
                fetched[binding.NodeId + "|" + binding.Key()] = value * FlowUnits.ToCanonicalFactor(metric, unit ?? binding.Source.Unit);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (Exception ex) { error ??= $"{entity}: {ex.Message}"; }
        }

        // Replaced wholesale rather than merged: an entity that stopped answering must drop out, not linger
        // at whatever it last read.
        values.Clear();
        foreach (var (k, v) in fetched) values[k] = v;
        lastFetch = DateTime.UtcNow;
        lastError = error;
    }
}
