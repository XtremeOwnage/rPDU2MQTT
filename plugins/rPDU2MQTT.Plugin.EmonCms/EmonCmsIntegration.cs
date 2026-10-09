using System.Text.Json;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Core.History;
using rPDU2MQTT.Core.Integrations;
using rPDU2MQTT.Helpers;
using rPDU2MQTT.Models.Config;

namespace rPDU2MQTT.Plugin.EmonCms;

/// <summary>
/// EmonCMS: a destination (measurements over its HTTP input API or its MQTT input), a history provider
/// (reading the feeds back), and a configuration publisher (provisioning those feeds and wiring each
/// input's processlist).
///
/// <para>
/// Three capabilities on one vendor and one config section — the case that decided a plugin is a vendor
/// rather than a single interface. Splitting it would have meant three plugins and three config sections
/// for something an operator sets up once.
/// </para>
/// </summary>
public sealed class EmonCmsIntegration
    : IIntegration, IMeasurementDestination, IMeasurementHistory, IConfigurationPublisher, IStatusProvider, IIntegrationApi,
      IHistoryBackend, IPluginHostUser, ISingleOwnerLeaseUser
{
    private static readonly HttpClient http = new();
    private Config cfg = new();
    private Func<IntegrationStatus> status = () => new();
    private EmonCmsFeedSync? feeds;
    private EmonCmsFlowHistory history = null!;
    private Func<IMessagePublisher?> publisher = () => null;
    // Provisioning writes to EmonCMS, so exactly one process may do it — two racing each other create
    // duplicate feeds. The lease is what makes it once.
    private ISingleOwnerLease lease = new SoleOwnerLease();

    /// <summary>Loaded as a plugin; the host supplies its services through <see cref="UseHost"/>.</summary>
    public EmonCmsIntegration() => Bind(cfg);

    public EmonCmsIntegration(
        Config cfg, IntegrationStatus status, EmonCmsFeedSync feeds,
        IMessagePublisher? publisher = null, ISingleOwnerLease? lease = null)
    {
        this.lease = lease ?? new SoleOwnerLease();
        this.status = () => status;
        this.feeds = feeds;
        this.publisher = () => publisher;
        Bind(cfg);
    }

    public void UseHost(IPluginHost host)
    {
        status = () => host.Status;
        feeds = new EmonCmsFeedSync(host.Config, () => host.Snapshots, () => host.LiveValues);
        publisher = () => host.Publisher;
        Bind(host.Config);
    }

    public void UseLease(ISingleOwnerLease lease) => this.lease = lease;

    private void Bind(Config c)
    {
        cfg = c;
        history = new EmonCmsFlowHistory(new HttpClient { Timeout = TimeSpan.FromSeconds(10) }, c);
    }

    private EmonCmsFeedSync Feeds => feeds ?? throw new InvalidOperationException("EmonCMS is not attached to a host.");

    // --- Identity -------------------------------------------------------------------------------------

    public string Id => "emoncms";
    public string DisplayName => "EmonCMS";
    public IntegrationGroup Group => IntegrationGroup.Destinations;

    public bool Enabled(Config c) => c.EmonCMS.Enabled;

    /// <summary>
    /// The URL is only needed for the HTTP transport; the MQTT transport uses the existing broker. A
    /// missing one used to throw during service registration, so enabling EmonCMS in the GUI before filling
    /// in the URL left the process unable to start — taking the PDU poll, MQTT, HA and the flow with it.
    /// A fault now disables this integration and says so; nothing a toggle can do may stop the bridge.
    /// </summary>
    public string? Misconfigured(Config c)
        => c.EmonCMS.Transport == EmonCmsTransport.Http && string.IsNullOrWhiteSpace(c.EmonCMS.Url)
            ? "EmonCMS is enabled with the HTTP transport but EmonCMS.Url is not set."
            : null;

    public async Task<(bool Ok, string Detail)> ProbeAsync(Config c, CancellationToken ct)
    {
        if (c.EmonCMS.Transport == EmonCmsTransport.Mqtt)
            return publisher() is not null ? (true, "publishing to the broker") : (false, "no broker publisher available");

        var (ok, detail) = await history.ProbeAsync(ct);
        return (ok, detail);
    }

    /// <summary>
    /// What "amber" means for EmonCMS, answered by the thing it is about.
    ///
    /// <para>
    /// Enabled with no attempt yet is <i>waiting</i>, not failing — the export runs on the leader, so on
    /// every other process there is genuinely nothing to report and calling that an error would light up
    /// the board on a healthy fleet.
    /// </para>
    /// </summary>
    public IntegrationHealth Status(Config c)
    {
        if (!Enabled(c)) return new(HealthLevel.Off, "Disabled");
        if (Misconfigured(c) is { } fault) return new(HealthLevel.Bad, "Misconfigured", fault);

        var last = status().For(Id);
        if (last?.LastAttemptUtc is null) return new(HealthLevel.Warn, "Waiting", $"{c.EmonCMS.Transport} · no export attempted yet");
        return last.LastOk == false
            ? new(HealthLevel.Bad, "Error", last.LastError ?? "Last export failed")
            : new(HealthLevel.Good, "Exporting", $"{c.EmonCMS.Transport} · {last.Count} values");
    }

    // --- Destination ----------------------------------------------------------------------------------

    public NodeTagFilter Tags(Config c) => c.EmonCMS.NodeTags;

    public async Task SendAsync(ExportPass pass, CancellationToken ct)
    {
        // What to send is Core's decision, so a test can hold it to account without a broker or a server.
        var payloads = EmonCmsPayload.Build(pass, cfg, Log.Warning);

        var total = payloads.Sum(p => p.Value.Count);
        if (total == 0) return;

        try
        {
            if (cfg.EmonCMS.Transport == EmonCmsTransport.Mqtt)
            {
                var broker = publisher() ?? throw new InvalidOperationException("No broker publisher is available for the EmonCMS MQTT transport.");
                foreach (var (device, values) in payloads)
                    await broker.PublishAsync(
                        MetricsHelper.EmonCmsMqttTopic(device, cfg), JsonSerializer.Serialize(values),
                        retain: false, ct, pass.AtUtc);
            }
            else if (payloads.TryGetValue(EmonCmsPayload.Combined, out var combined))
            {
                await SendViaHttp(combined, ct);
            }

            status().RecordSuccess(Id, total);
        }
        catch (Exception ex)
        {
            // Recorded here for the GUI's own indicator, then rethrown so the host records it against this
            // integration on the Status board. One destination failing never stops the others.
            status().RecordFailure(Id, ex.Message);
            throw;
        }
    }

    private async Task SendViaHttp(Dictionary<string, double> values, CancellationToken ct)
    {
        var c = cfg.EmonCMS;
        var url = (c.Url ?? string.Empty).TrimEnd('/') + "/" + (c.Path ?? "input/post").TrimStart('/');
        var form = new Dictionary<string, string>
        {
            ["node"] = c.Node,
            ["apikey"] = c.ApiKey ?? string.Empty,
            ["fulljson"] = JsonSerializer.Serialize(values),
        };

        using var content = new FormUrlEncodedContent(form);
        var response = await http.PostAsync(url, content, ct);
        var body = await response.Content.ReadAsStringAsync(ct);

        if (!response.IsSuccessStatusCode) throw new Exception($"HTTP {(int)response.StatusCode}: {body}");
        // EmonCMS answers 200 even on auth/permission failures, flagged in the JSON body.
        if (body.Contains("\"success\":false", StringComparison.OrdinalIgnoreCase))
            throw new Exception($"EmonCMS rejected the post: {body}");
    }

    // --- Configuration publisher ----------------------------------------------------------------------
    // Feeds are not measurements: they are the structure EmonCMS needs before a measurement means anything,
    // they change when the operator changes something rather than every poll, and this is the button the
    // GUI has always had.

    public bool PublishingEnabled(Config c) => c.EmonCMS.Enabled && c.EmonCMS.Feeds.AutoConfigure;

    public async Task<string> PublishAsync(ExportPass pass, CancellationToken ct)
    {
        var message = "Another instance is provisioning EmonCMS feeds.";
        await lease.RunIfOwnerAsync("emoncms:feeds",
            async token => message = (await Feeds.ReconcileAsync(pass.Snapshot, token)).Message, ct);
        return message;
    }

    /// <summary>Removes the inputs this bridge no longer sends and the feeds it no longer provisions.</summary>
    public async Task<string> SweepAsync(ExportPass pass, CancellationToken ct)
    {
        var message = "Another instance is managing EmonCMS feeds.";
        await lease.RunIfOwnerAsync("emoncms:feeds",
            async token => message = (await Feeds.DeleteStaleAsync(pass.Snapshot, inputs: true, feeds: true, token)).Message, ct);
        return message;
    }

    // --- Cleanup actions ------------------------------------------------------------------------------

    public IReadOnlyList<IntegrationAction> Actions =>
    [
        new("stale", "Find old inputs and feeds",
            "List the inputs under this bridge's node that it no longer sends, and the feeds under its tags that the current configuration no longer provisions.",
            ActionEffect.Read,
            async (_, ct) =>
            {
                var plan = await Feeds.FindStaleAsync(Feeds.Merged(), ct);
                return new
                {
                    ok = plan.Refused is null,
                    message = plan.Refused,
                    inputs = plan.Inputs.Select(i => $"{i.Node}/{i.Name}").ToList(),
                    feeds = plan.Feeds.Select(f => $"{f.Tag}/{f.Name}").ToList(),
                };
            }),
        new("sweep-inputs", "Delete old inputs",
            "Delete the inputs under this bridge's node that it no longer sends. No feed data is stored on an input.",
            ActionEffect.Write,
            (_, ct) => CleanAsync(inputs: true, feedsToo: false, ct)),
        new("sweep-feeds", "Delete old feeds",
            "Delete the feeds under this bridge's tags that the current configuration no longer provisions, and their stored history.",
            ActionEffect.Destructive,
            (_, ct) => CleanAsync(inputs: false, feedsToo: true, ct)),
        new("delete-all-feeds", "Delete all feeds",
            "Delete every feed under this bridge's tags, and their stored history.",
            ActionEffect.Destructive,
            async (_, ct) =>
            {
                object? result = new { ok = false, message = "Another instance is managing EmonCMS feeds." };
                await lease.RunIfOwnerAsync("emoncms:feeds", async token =>
                {
                    var r = await Feeds.DeleteAllAsync(token);
                    result = new { ok = r.Ok, message = r.Message };
                }, ct);
                return result;
            }),
    ];

    private async Task<object?> CleanAsync(bool inputs, bool feedsToo, CancellationToken ct)
    {
        object? result = new { ok = false, message = "Another instance is managing EmonCMS feeds." };
        await lease.RunIfOwnerAsync("emoncms:feeds", async token =>
        {
            var r = await Feeds.DeleteStaleAsync(Feeds.Merged(), inputs, feedsToo, token);
            result = new { ok = r.Ok, message = r.Message };
        }, ct);
        return result;
    }

    // --- History --------------------------------------------------------------------------------------

    public Task<IReadOnlyDictionary<string, double>> ValuesAtAsync(
        IReadOnlyCollection<string> nodeIds, string metric, DateTime atUtc, CancellationToken ct)
        => history.ValuesAtAsync(nodeIds, metric, atUtc, ct);

    public Task<(bool Ok, string Detail)> ProbeAsync(CancellationToken ct) => history.ProbeAsync(ct);

    public string HistoryId => Id;

    public IMeasurementHistory CreateHistory(HttpClient client, Config c) => new EmonCmsFlowHistory(client, c);

    public IHistoryTarget? CreateHistoryTarget(HttpClient client, Config c) => new EmonCmsHistoryTarget(client, c);

    public string? HistoryUnavailable(Config c) => string.IsNullOrWhiteSpace(c.EmonCMS.Url) ? "EmonCMS.Url is not set" : null;
}
