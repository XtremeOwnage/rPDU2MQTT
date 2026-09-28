using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.History;

namespace rPDU2MQTT.Integrations.Local;

/// <summary>Writes copied history into the bridge's own store, filling only empty slots.</summary>
public sealed class LocalHistoryTarget(Config cfg, LocalSeriesStore store) : IHistoryTarget
{
    public string Id => "local";

    public string? Unavailable => cfg.History.LocalEnabled ? null : "local history is off (History.LocalEnabled)";

    public (DateTime From, DateTime To)? Missing(string node, string metric, DateTime fromUtc, DateTime toUtc, int intervalSeconds)
        => store.Missing(node, metric, fromUtc, toUtc, intervalSeconds);

    public Task<int> WriteAsync(string node, string label, string kind, string metric,
                                IReadOnlyList<(DateTime At, double Value)> readings, int intervalSeconds, DateTime nowUtc, bool replace, CancellationToken ct)
        => Task.FromResult(store.Import(node, metric, readings, nowUtc, replace));
}
