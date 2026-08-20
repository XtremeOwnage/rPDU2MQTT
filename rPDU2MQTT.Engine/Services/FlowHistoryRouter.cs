using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Integrations.EmonCms;
using rPDU2MQTT.Integrations.Prometheus;

namespace rPDU2MQTT.Services;

/// <summary>
/// Chooses the backend per call from the live configuration.
/// </summary>
public sealed class FlowHistoryRouter(HttpClient http, Config cfg) : IMeasurementHistory
{
    private readonly PrometheusFlowHistory prometheus = new(http, cfg);
    private readonly EmonCmsFlowHistory emoncms = new(http, cfg);
    private readonly Integrations.HomeAssistant.HomeAssistantHistory homeAssistant = new(http, cfg);

    // Chosen by id from live config, so adding a backend is one more line here and nothing else — the
    // property that made IMeasurementHistory the template the rest of the contracts were copied from.
    private IMeasurementHistory Current => cfg.History.Provider?.ToLowerInvariant() switch
    {
        "emoncms" => emoncms,
        "homeassistant" => homeAssistant,
        _ => prometheus,
    };

    public string Id => Current.Id;

    public Task<IReadOnlyDictionary<string, double>> ValuesAtAsync(
        IReadOnlyCollection<string> nodeIds, string metric, DateTime atUtc, CancellationToken ct)
        => cfg.History.Enabled
            ? Current.ValuesAtAsync(nodeIds, metric, atUtc, ct)
            : Task.FromResult<IReadOnlyDictionary<string, double>>(new Dictionary<string, double>());

    public Task<(bool Ok, string Detail)> ProbeAsync(CancellationToken ct)
        => cfg.History.Enabled ? Current.ProbeAsync(ct) : Task.FromResult((false, "history is turned off"));

    public Task<IReadOnlyList<IReadOnlyDictionary<string, double>>> SeriesAsync(
        IReadOnlyCollection<string> nodeIds, string metric, IReadOnlyList<DateTime> steps, CancellationToken ct)
        => Current.SeriesAsync(nodeIds, metric, steps, ct);
}
