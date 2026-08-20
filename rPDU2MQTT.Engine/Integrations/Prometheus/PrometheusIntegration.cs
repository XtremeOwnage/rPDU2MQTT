using global::Prometheus;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Core.Integrations;
using rPDU2MQTT.Helpers;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Services;
// The client library and Core.Flow both define a Gauge; in this file it is always the metric.
using Gauge = global::Prometheus.Gauge;
using Metrics = global::Prometheus.Metrics;
using rPDU2MQTT.Integrations.Prometheus;

namespace rPDU2MQTT.Integrations.Prometheus;

/// <summary>
/// Prometheus: a destination (a scrape endpoint and/or a Pushgateway) and a history provider (reading the
/// series back), as one integration.
///
/// <para>
/// It is the proving case for the plugin contracts precisely because it is two capabilities on one vendor
/// with one config section — the arrangement a one-interface-per-plugin model could not express without
/// splitting it into two plugins an operator thinks of as one.
/// </para>
/// <para>
/// Gauges live for the process, and every replica serves its own <c>/metrics</c>, so this is the
/// destination that is deliberately <b>not</b> leader-gated.
/// </para>
/// </summary>
public sealed class PrometheusIntegration : IIntegration, IMeasurementDestination, IMeasurementHistory, IStatusProvider, IDisposable
{
    private readonly Config cfg;
    private readonly Dictionary<string, Gauge> gauges = new();
    private readonly PrometheusFlowHistory history;
    private IMetricServer? exporter;
    private IMetricServer? pusher;
    private bool started;

    /// <param name="http">
    /// Optional so the integration can be constructed by the registry's reflection pass without the host
    /// having to register an HttpClient purely for it; a plugin that needs one and is not given one owns a
    /// bounded default rather than failing to activate.
    /// </param>
    public PrometheusIntegration(Config cfg, HttpClient? http = null)
    {
        this.cfg = cfg;
        history = new PrometheusFlowHistory(http ?? new HttpClient { Timeout = TimeSpan.FromSeconds(10) }, cfg);
    }

    // --- Identity -------------------------------------------------------------------------------------

    public string Id => "prometheus";
    public string DisplayName => "Prometheus";
    public IntegrationGroup Group => IntegrationGroup.Destinations;

    public bool Enabled(Config c) => c.Prometheus.Exporter || c.Prometheus.Pushgateway.Enabled;

    public string? Misconfigured(Config c)
        => c.Prometheus.Pushgateway.Enabled && string.IsNullOrWhiteSpace(c.Prometheus.Pushgateway.Url)
            ? "Prometheus Pushgateway is enabled but Prometheus.Pushgateway.Url is not set; no metrics will be pushed."
            : null;

    public Task<(bool Ok, string Detail)> ProbeAsync(Config c, CancellationToken ct)
        => c.History.Enabled && string.Equals(c.History.Provider, Id, StringComparison.OrdinalIgnoreCase)
            ? history.ProbeAsync(ct)
            : Task.FromResult((true, c.Prometheus.Exporter ? $"serving :{c.Prometheus.Port}/metrics" : "push only"));

    /// <summary>
    /// Prometheus is healthy when it is serving or pushing — its own answer, because "exporting" here means
    /// the endpoint is up on THIS process, not that anything scraped it. A scrape nobody performed is not a
    /// fault of this bridge.
    /// </summary>
    public IntegrationHealth Status(Config c)
    {
        if (!Enabled(c)) return new(HealthLevel.Off, "Exporter off");
        if (Misconfigured(c) is { } fault) return new(HealthLevel.Bad, "Misconfigured", fault);
        return new(HealthLevel.Good, c.Prometheus.Exporter ? "Exporter on" : "Pushing",
            c.Prometheus.Exporter ? $":{c.Prometheus.Port}/metrics" : c.Prometheus.Pushgateway.Url);
    }

    // --- Destination ----------------------------------------------------------------------------------

    /// <summary>
    /// Every replica serves its own <c>/metrics</c>, so every replica refreshes its own gauges. Gating this
    /// on leadership would leave a scrape of any other pod reading whatever it last held the lease for.
    /// </summary>
    public bool LeaderGated => false;

    public NodeTagFilter Tags(Config c) => c.Prometheus.NodeTags;

    public Task SendAsync(ExportPass pass, CancellationToken ct)
    {
        EnsureServers();

        var labelNames = PrometheusLabels.Names(cfg);
        // The energy-flow tier feeding each reading — only built when the hierarchy label is wanted.
        var hierarchy = labelNames.Contains("hierarchy") ? BuildHierarchy(pass) : null;

        // What each gauge was given this pass, so anything it held from a previous one can be dropped below.
        var written = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);

        foreach (var r in pass.Readings)
        {
            var tier = hierarchy is null ? string.Empty : HierarchyFor(hierarchy, r);
            var values = PrometheusLabels.Values(labelNames, r, cfg, r.InstanceId, tier);
            var name = MetricsHelper.PrometheusMetricName(r, cfg);
            GetGauge(name, labelNames, r).WithLabels(values).Set(r.Value);
            if (!written.TryGetValue(name, out var set)) written[name] = set = new(StringComparer.Ordinal);
            set.Add(LabelKey(values));
        }

        // An outlet that goes away — unplugged, renamed, a PDU dropped from the config.
        foreach (var (name, set) in written)
            if (gauges.TryGetValue(name, out var g))
                Prune(g, set);

        ExportFlowTiers(pass);
        return Task.CompletedTask;
    }

    /// <summary>
    /// The energy-flow hierarchy as its own metric family: one series per tier, per metric.
    /// </summary>
    private void ExportFlowTiers(ExportPass pass)
    {
        if (pass.Tiers.Count == 0) return;

        // Power defines the topology (and therefore the tier labels).
        var power = pass.Tiers[0].Graph;
        var labels = power.Nodes.ToDictionary(n => n.Id, n => n, StringComparer.OrdinalIgnoreCase);

        foreach (var (metric, graph) in pass.Tiers)
        {
            var name = MetricsHelper.PrometheusFlowMetricName(metric, cfg);
            var gauge = FlowGauge(name, metric, graph.Units);
            var written = new HashSet<string>(StringComparer.Ordinal);

            foreach (var t in FlowTiers.Of(graph, cfg.Prometheus.NodeTags))
            {
                var tier = FlowExport.Parents(power, t.Node.Id).FirstOrDefault() ?? "";
                var set = new[] { t.Node.Id, t.Node.Label, t.Node.Kind, labels.TryGetValue(tier, out var p) ? p.Label : tier };
                gauge.WithLabels(set).Set(t.Value);
                written.Add(LabelKey(set));
            }

            // Drop every label set we did NOT write this pass.
            Prune(gauge, written);
        }
    }

    // --- History --------------------------------------------------------------------------------------
    // Delegated rather than reimplemented: the reader already exists and reads the same metric names this
    // destination writes, through MetricsHelper.PrometheusFlowMetricName.

    public Task<IReadOnlyDictionary<string, double>> ValuesAtAsync(
        IReadOnlyCollection<string> nodeIds, string metric, DateTime atUtc, CancellationToken ct)
        => history.ValuesAtAsync(nodeIds, metric, atUtc, ct);

    public Task<IReadOnlyList<IReadOnlyDictionary<string, double>>> SeriesAsync(
        IReadOnlyCollection<string> nodeIds, string metric, IReadOnlyList<DateTime> steps, CancellationToken ct)
        => history.SeriesAsync(nodeIds, metric, steps, ct);

    public Task<(bool Ok, string Detail)> ProbeAsync(CancellationToken ct) => history.ProbeAsync(ct);

    // --- The scrape endpoint and the pusher -----------------------------------------------------------

    /// <summary>
    /// Started on the first pass rather than in the constructor, so a port that is already taken fails
    /// where it can be reported against this integration instead of during service registration.
    /// </summary>
    private void EnsureServers()
    {
        if (started) return;
        started = true;

        var c = cfg.Prometheus;
        if (c.Exporter)
        {
            try
            {
                exporter = new MetricServer(port: c.Port).Start();
                Log.Information($"Prometheus exporter listening on :{c.Port}/metrics");
            }
            catch (Exception ex)
            {
                Log.Error(ex, $"Failed to start the Prometheus exporter on port {c.Port}.");
            }
        }

        if (c.Pushgateway.Enabled && !string.IsNullOrWhiteSpace(c.Pushgateway.Url))
        {
            try
            {
                var seconds = c.Pushgateway.IntervalSeconds > 0 ? c.Pushgateway.IntervalSeconds : cfg.Primary.PollInterval;
                pusher = new MetricPusher(new MetricPusherOptions
                {
                    Endpoint = c.Pushgateway.Url,
                    Job = c.Pushgateway.Job,
                    IntervalMilliseconds = Math.Max(1, seconds) * 1000,
                }).Start();
                Log.Information($"Prometheus pushing to {c.Pushgateway.Url} (job '{c.Pushgateway.Job}') every {seconds}s.");
            }
            catch (Exception ex)
            {
                Log.Error(ex, "Failed to start the Prometheus Pushgateway pusher.");
            }
        }
    }

    public void Dispose()
    {
        exporter?.Dispose();
        pusher?.Dispose();
    }

    // --- Gauges ---------------------------------------------------------------------------------------

    private static readonly string[] FlowLabelNames = ["node", "name", "kind", "tier"];

    /// <summary>A label set as one comparable string. The separator is a unit separator, which cannot occur
    /// in a label value, so two different sets can never collide into one key.</summary>
    internal static string LabelKey(IReadOnlyList<string> labels) => string.Join('␟', labels);

    /// <summary>Forget every label set this gauge holds that was not written in the pass just finished.</summary>
    internal static void Prune(Collector<Gauge.Child> gauge, HashSet<string> written)
    {
        foreach (var stale in gauge.GetAllLabelValues().Where(l => !written.Contains(LabelKey(l))).ToList())
            gauge.RemoveLabelled(stale);
    }

    private Gauge FlowGauge(string name, string metric, string units)
    {
        if (!gauges.TryGetValue(name, out var gauge))
        {
            var friendly = MetricsHelper.FriendlyTypeName(metric);
            var u = string.IsNullOrWhiteSpace(units) ? "" : $" ({units})";
            gauge = Metrics.CreateGauge(name,
                $"{(string.IsNullOrWhiteSpace(friendly) ? metric : friendly)}{u} for an energy-flow tier, rolled up by rPDU2MQTT.",
                FlowLabelNames);
            gauges[name] = gauge;
        }
        return gauge;
    }

    /// <summary>
    /// The gauge for a metric name, created on first use. Its HELP text is the measurement said in English
    /// with its unit (#206), so a series is readable in Grafana's metric browser without knowing this
    /// project's vocabulary.
    /// </summary>
    private Gauge GetGauge(string name, string[] labelNames, MeasurementReading reading)
    {
        if (!gauges.TryGetValue(name, out var gauge))
        {
            var friendly = MetricsHelper.FriendlyTypeName(reading.Type);
            var units = string.IsNullOrWhiteSpace(reading.Units) ? "" : $" ({reading.Units})";
            var help = string.IsNullOrWhiteSpace(friendly)
                ? "Measured by rPDU2MQTT."
                : $"{friendly}{units}, measured by rPDU2MQTT.";

            gauge = Metrics.CreateGauge(name, help, labelNames);
            gauges[name] = gauge;
        }
        return gauge;
    }

    /// <summary>Flow-node id -> the label of the tier feeding it, from the pass's own power graph.</summary>
    private static Dictionary<string, string> BuildHierarchy(ExportPass pass)
    {
        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (pass.Tiers.Count == 0) return map;

        var graph = pass.Tiers[0].Graph;
        var labels = graph.Nodes.ToDictionary(n => n.Id, n => n.Label, StringComparer.OrdinalIgnoreCase);
        foreach (var node in graph.Nodes)
            if (FlowExport.Parents(graph, node.Id).FirstOrDefault() is { } parent)
                map[node.Id] = labels.TryGetValue(parent, out var l) ? l : parent;
        return map;
    }

    private static string HierarchyFor(Dictionary<string, string> map, MeasurementReading r)
        // The reading knows which node it is; it used to be rebuilt here from Device + Number, one of the
        // two places that had to remember Number is 1-based and the graph's key is 0-based.
        => map.TryGetValue(r.NodeId, out var tier) ? tier : string.Empty;
}
