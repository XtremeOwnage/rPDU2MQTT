using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Core.Integrations;
using rPDU2MQTT.Models.Config;

namespace rPDU2MQTT.Integrations.EmonCms;

/// <summary>
/// EmonCMS read the other way round: a flow node valued from a feed's current reading.
///
/// <para>
/// This bridge already writes to EmonCMS and already reads its feeds for history. What it could not do was
/// take a feed as a <i>live</i> value — so a circuit already metered by an IotaWatt, an emonTx or anything
/// else posting to the same server had to be re-plumbed through MQTT before it could appear in the energy
/// hierarchy, even though the number was sitting in a feed the whole time. Binding <c>Type: emoncms</c>
/// with the feed reads it directly.
/// </para>
/// <para>
/// Polled, and the whole poll is one request: <c>/feed/list.json</c> answers with every feed's id, name,
/// tag, unit, current value <i>and</i> the time it was recorded. Reading feeds one at a time would cost a
/// request each and — with <c>feed/fetch.json</c> — arrive without timestamps, leaving no way to tell a
/// feed that stopped an hour ago from one being written right now.
/// </para>
/// <para>
/// A feed's own timestamp is what freshness is judged against, not the moment this poll happened to run. A
/// dead IotaWatt leaves its last reading sitting in the feed forever, and treating "we fetched it just now"
/// as "it is current" would prop the whole hierarchy up on a number that stopped being true overnight.
/// </para>
/// </summary>
public sealed class EmonCmsValueSource
    : IIntegration, IValueSourcePlugin, IIntegrationApi, IStatusProvider, IFlowValueDiagnostics, IWithheldSources
{
    private readonly HttpClient http;
    private readonly Config cfg;
    private readonly IPeriodAuditor? auditor;

    // The staleness rules live in the cache (Core), as they do for the MQTT and Modbus ingests, so a
    // reading expires by exactly the same rule wherever it came from.
    private readonly FlowValueCache latest = new();

    private IReadOnlyList<SourceBinding> bindings = [];
    private DateTime lastFetch = DateTime.MinValue;
    private string? lastError;
    private int resolved;
    private volatile WithheldSource[] unresolved = [];

    public EmonCmsValueSource(Config cfg, HttpClient? http = null, IPeriodAuditor? auditor = null)
    {
        this.cfg = cfg;
        this.auditor = auditor;
        this.http = http ?? new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
    }

    // --- Identity -------------------------------------------------------------------------------------

    public string Id => "emoncms-source";
    public string DisplayName => "EmonCMS feeds";
    public IntegrationGroup Group => IntegrationGroup.Integrations;

    public string SourceType => "emoncms";
    public string SourceTypeLabel => "EmonCMS feed";

    /// <summary>
    /// On when something is bound to it. A configured EmonCMS is not a reason to poll — this install
    /// exports to EmonCMS and reads nothing back, and that has to stay free.
    /// </summary>
    public bool Enabled(Config c) => SourceBindings.For(c, SourceType).Count > 0;

    /// <summary>
    /// The URL is what a read needs. Note this does not require <c>EmonCMS.Enabled</c>: reading feeds is not
    /// exporting, and someone reading a neighbouring EmonCMS without pushing anything to it is a perfectly
    /// ordinary setup.
    /// </summary>
    public string? Misconfigured(Config c)
        => Enabled(c) && string.IsNullOrWhiteSpace(c.EmonCMS.Url)
            ? "Nodes are bound to EmonCMS feeds, but EmonCMS.Url is not set."
            : null;

    /// <summary>How often the host should call <see cref="ReconcileAsync"/> — this is a poller, not a subscriber.</summary>
    public int RefreshSeconds => Math.Clamp(cfg.EmonCMS.Source.PollIntervalSeconds, 5, 3600);

    public IntegrationHealth Status(Config c)
    {
        if (!Enabled(c)) return new(HealthLevel.Off, "No feeds bound");
        if (Misconfigured(c) is { } fault) return new(HealthLevel.Bad, "Misconfigured", fault);
        if (lastFetch == DateTime.MinValue)
            return new(HealthLevel.Warn, "No data yet", $"{bindings.Count} feed binding(s), not yet read");
        if (lastError is not null) return new(HealthLevel.Bad, "Cannot read", lastError);

        // A binding pointing at a feed that is not there is the failure worth seeing: the config looks
        // complete, the server answers, and the node still reads "no data".
        var missing = unresolved.Length;
        return missing > 0
            ? new(HealthLevel.Warn, "Some feeds not found", $"{missing} of {bindings.Count} binding(s) name a feed this server does not have")
            : new(HealthLevel.Good, "Reading", $"{resolved} of {bindings.Count} feed binding(s)");
    }

    // --- Values ---------------------------------------------------------------------------------------

    public bool TryGetValue(string nodeId, string metric, out double value)
        => latest.TryGetValue(nodeId, metric, out value);

    /// <summary>Testable overload: resolve freshness against an explicit "now".</summary>
    public bool TryGetValue(string nodeId, string metric, DateTime nowUtc, out double value)
        => latest.TryGetValue(nodeId, metric, nowUtc, out value);

    public IReadOnlyCollection<(string Node, string Metric)> ReportedKeys => latest.Keys;

    public bool TryDescribe(string nodeId, string metric, out FlowReading reading)
        => latest.TryDescribe(nodeId, metric, out reading);

    /// <summary>Testable overload: resolve freshness against an explicit "now".</summary>
    public bool TryDescribe(string nodeId, string metric, DateTime nowUtc, out FlowReading reading)
        => latest.TryDescribe(nodeId, metric, nowUtc, out reading);

    /// <summary>
    /// Bindings whose value is missing and why — a feed nobody can find, a name that matches several tags,
    /// a counter the period audit rejected. The GUI shows these where the number would have been.
    /// </summary>
    /// <summary>
    /// What this ingest is dropping. The period audit is shared with the MQTT and Modbus ingests, so only
    /// the entries naming a feed this one actually audited are its own — taking the whole list reported
    /// every other ingest's withheld bindings as EmonCMS's too.
    /// </summary>
    public IReadOnlyCollection<WithheldSource> Withheld =>
        [.. unresolved, .. ((IWithheldSources)latest).Withheld,
         .. (auditor?.Withheld ?? []).Where(Mine)];

    /// <summary>
    /// Is this the audit's verdict on one of THIS ingest's feeds?
    ///
    /// <para>
    /// Decided from the bindings and the label this ingest writes, both of which exist the moment the config
    /// is read. Remembering what it happened to audit during this run would answer the same question, and
    /// answer it wrongly for the first poll after every restart: the audit itself is restored from the store
    /// on startup, so its verdicts outlive the process, and a report derived from them has to as well.
    /// </para>
    /// </summary>
    private bool Mine(WithheldSource w)
        => w.Source.StartsWith(FeedLabelPrefix, StringComparison.Ordinal)
           && bindings.Any(b => string.Equals(b.NodeId, w.Node, StringComparison.OrdinalIgnoreCase));

    /// <summary>How this ingest names a feed to the audit. One definition, written and matched in one place.</summary>
    private const string FeedLabelPrefix = "EmonCMS feed '";

    public async Task ReconcileAsync(Config c, IReadOnlyList<SourceBinding> bound, CancellationToken ct)
    {
        Bind(bound);
        await FetchAsync(DateTime.UtcNow, ct);
    }

    /// <summary>
    /// Take up these bindings without reading the server. Splitting this out of
    /// <see cref="ReconcileAsync"/> is what lets every resolution rule be driven against a fixed feed list
    /// in a test, with no HTTP anywhere near it.
    /// </summary>
    public void Bind(IReadOnlyList<SourceBinding> bound) => bindings = bound;

    /// <summary>Parse an EmonCMS <c>/feed/list.json</c> body into the feeds <see cref="Apply"/> takes.</summary>
    public static IReadOnlyList<EmonCmsFeed> ReadFeedList(string json) => EmonCmsWire.FeedStates(json);

    /// <summary>Read the feed list once and apply it to every binding. Public so a test can drive one pass.</summary>
    public async Task FetchAsync(DateTime nowUtc, CancellationToken ct)
    {
        if (bindings.Count == 0 || Misconfigured(cfg) is not null) return;

        var baseUrl = (cfg.EmonCMS.Url ?? "").TrimEnd('/');
        var key = cfg.EmonCMS.ApiKey ?? "";

        string body;
        try
        {
            var response = await http.GetAsync($"{baseUrl}/feed/list.json?apikey={Uri.EscapeDataString(key)}", ct);
            if (!response.IsSuccessStatusCode)
            {
                // Left alone rather than cleared: one refused request is not evidence that the feeds stopped,
                // and the readings expire on their own timestamps anyway.
                lastError = $"{baseUrl}: HTTP {(int)response.StatusCode} listing feeds"
                          + ((int)response.StatusCode == 401 || (int)response.StatusCode == 403
                              ? " — the API key cannot read this server's feeds" : "");
                return;
            }
            body = await response.Content.ReadAsStringAsync(ct);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception ex) { lastError = $"{baseUrl}: {ex.Message}"; return; }

        Apply(EmonCmsWire.FeedStates(body), nowUtc);
        lastFetch = nowUtc;
        lastError = null;
    }

    /// <summary>
    /// Match the bindings against the feeds and cache what they resolve to. Separated from the fetch so
    /// every resolution rule — id, name, tag-qualified name, ambiguity, staleness, units — is testable
    /// against a payload without a server.
    /// </summary>
    public void Apply(IReadOnlyList<EmonCmsFeed> feeds, DateTime nowUtc)
    {
        var index = FeedIndex.Of(feeds);
        var missing = new List<WithheldSource>();
        var periodKey = CurrentPeriodKey(nowUtc);
        var found = 0;

        // Readings no longer produced by any current binding are dropped, so retyping or deleting a source
        // stops feeding the graph on the next poll rather than lingering until it expires.
        var live = bindings
            .SelectMany(b => FlowMetricKey.Keys(FlowMetricKey.ForAccumulation(b.Source.Metric, b.Source.Accumulation), b.Source.Direction)
                .Select(k => (b.NodeId, Key: k)))
            .ToHashSet();
        foreach (var stale in latest.Keys.Where(k => !live.Contains((k.Node, k.Metric))).ToList())
            latest.Remove(stale.Node, stale.Metric);

        foreach (var binding in bindings)
        {
            var wanted = Address(binding);
            if (string.IsNullOrWhiteSpace(wanted))
            {
                missing.Add(new(binding.NodeId, "emoncms", binding.Metric,
                    "This binding does not say which EmonCMS feed to read. Set its Feed to the feed's id or name."));
                continue;
            }

            var (feed, why) = index.Find(wanted!);
            if (feed is null)
            {
                missing.Add(new(binding.NodeId, $"EmonCMS feed '{wanted}'", binding.Metric, why));
                continue;
            }

            // A feed that exists but has never been written holds no value. That is not zero, and saying it
            // is would roll a made-up number all the way up the hierarchy.
            if (feed.Value is not { } raw)
            {
                missing.Add(new(binding.NodeId, $"EmonCMS feed '{feed.Name}' ({feed.Id})", binding.Metric,
                    "The feed exists but has no value yet — nothing has been logged to it."));
                continue;
            }

            found++;

            // Converted to the metric's canonical unit on the way in, as every other ingest does, so a feed
            // in kW and one in W roll up together instead of differing by a thousand. The binding's own Unit
            // wins over the server's, because an operator correcting a mislabelled feed has nowhere else to
            // say so.
            var unit = !string.IsNullOrWhiteSpace(binding.Source.Unit) ? binding.Source.Unit : feed.Unit;
            var value = raw * FlowUnits.ToCanonicalFactor(binding.Source.Metric, unit) * binding.Source.Scale;

            // The same check the MQTT and Modbus ingests apply: a feed declared as a daily counter has to
            // actually reset at the period boundary, or whatever it holds is not today's total. EmonCMS
            // makes this easy to get wrong — a kWh feed and a kWh/d feed sit side by side under nearly the
            // same name, and binding the cumulative one as 'period' would report a lifetime total as today.
            if (auditor is not null && PeriodCounterAudit.Applies(binding.Source)
                && !Audit(binding.NodeId, $"{FeedLabelPrefix}{feed.Name}'", binding.Source.Direction, periodKey, value))
                continue;

            // Judged against the feed's own timestamp, not this poll: a publisher that died leaves its last
            // reading in place, and "we fetched it a second ago" says nothing about when it was true. A feed
            // EmonCMS gave no timestamp for is taken as current, which is all that can be said about it.
            var at = feed.AtUtc ?? nowUtc;
            foreach (var (metricKey, v) in FlowMetricKey.Fan(
                         FlowMetricKey.ForAccumulation(binding.Source.Metric, binding.Source.Accumulation),
                         binding.Source.Direction, value))
                latest.Set(binding.NodeId, metricKey, v, binding.Source.StaleAfterSeconds, at);
        }

        resolved = found;
        unresolved = [.. missing];
    }

    /// <summary>Which feed a binding names: its typed <c>Feed</c> field, or the same name in the open settings bag.</summary>
    private static string? Address(SourceBinding binding)
        => !string.IsNullOrWhiteSpace(binding.Source.Feed) ? binding.Source.Feed!.Trim()
         : binding.Setting("Feed")?.Trim();

    /// <summary>The period a reading belongs to, on the same boundary the daily accumulator uses.</summary>
    private string CurrentPeriodKey(DateTime nowUtc)
    {
        var agg = cfg.EnergyFlow.Aggregation;
        return EnergyPeriod.KeyFor(nowUtc, EnergyPeriod.Resolve(agg.PeriodTimeZone), agg.PeriodStartHour);
    }

    /// <summary>Ask the audit's owner; an unreachable owner leaves the reading published, as elsewhere.</summary>
    private bool Audit(string nodeId, string source, string? direction, string periodKey, double value)
    {
        try { return auditor!.Allow(nodeId, source, direction, periodKey, value); }
        catch (Exception ex)
        {
            Log.Debug($"Energy-flow EmonCMS: could not consult the period audit ({ex.Message}).");
            return true;
        }
    }

    // --- Actions --------------------------------------------------------------------------------------

    /// <summary>
    /// Listing the feeds, so the node editor can offer them instead of asking someone to type a name they
    /// have to go and look up in another tab.
    /// </summary>
    public IReadOnlyList<IntegrationAction> Actions =>
    [
        new("feeds", "List feeds", "List the feeds on the EmonCMS server, so a binding can pick one.",
            ActionEffect.Read,
            async (ctx, ct) =>
            {
                var baseUrl = (ctx.Config.EmonCMS.Url ?? "").TrimEnd('/');
                if (baseUrl.Length == 0) return new { ok = false, message = "EmonCMS.Url is not set.", feeds = Array.Empty<object>() };

                var key = ctx.Config.EmonCMS.ApiKey ?? "";
                try
                {
                    var response = await http.GetAsync($"{baseUrl}/feed/list.json?apikey={Uri.EscapeDataString(key)}", ct);
                    if (!response.IsSuccessStatusCode)
                        return new { ok = false, message = $"EmonCMS answered HTTP {(int)response.StatusCode}.", feeds = Array.Empty<object>() };

                    var feeds = EmonCmsWire.FeedStates(await response.Content.ReadAsStringAsync(ct))
                        .OrderBy(f => f.Tag, StringComparer.OrdinalIgnoreCase)
                        .ThenBy(f => f.Name, StringComparer.OrdinalIgnoreCase)
                        .Select(f => new { id = f.Id, name = f.Name, tag = f.Tag, unit = f.Unit, value = f.Value, at = f.AtUtc })
                        .ToArray();
                    return new { ok = true, message = $"{feeds.Length} feed(s).", feeds };
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    return new { ok = false, message = ex.Message, feeds = Array.Empty<object>() };
                }
            }),
    ];

    public async Task<(bool Ok, string Detail)> ProbeAsync(Config c, CancellationToken ct)
    {
        var baseUrl = (c.EmonCMS.Url ?? "").TrimEnd('/');
        if (baseUrl.Length == 0) return (false, "no EmonCMS URL set");
        try
        {
            var response = await http.GetAsync($"{baseUrl}/feed/list.json?apikey={Uri.EscapeDataString(c.EmonCMS.ApiKey ?? "")}", ct);
            if (!response.IsSuccessStatusCode) return (false, $"{baseUrl}: HTTP {(int)response.StatusCode}");
            var feeds = EmonCmsWire.FeedStates(await response.Content.ReadAsStringAsync(ct));

            // Naming what is actually bound but missing, rather than a bare feed count: a server full of
            // feeds proves nothing if none of them is the one this config asks for.
            var absent = unresolved.Length;
            return (true, absent > 0
                ? $"{baseUrl} · {feeds.Count} feed(s), but {absent} binding(s) name one that is not among them"
                : $"{baseUrl} · {feeds.Count} feed(s)");
        }
        catch (Exception ex) when (ex is not OperationCanceledException) { return (false, $"{baseUrl}: {ex.Message}"); }
    }

    /// <summary>
    /// Finding the feed a binding names.
    ///
    /// <para>
    /// Three ways to name one, in order of how specific they are: the numeric id, a <c>tag/name</c> pair,
    /// and a bare name. The bare name is the one people will type and the one that can go wrong — EmonCMS
    /// names are unique only within a tag, so "energy" may well exist under both <c>solar</c> and
    /// <c>grid</c>. Picking whichever came back first would bind a node to a feed nobody chose, and the
    /// mistake would look exactly like a working configuration. It is reported as ambiguous instead.
    /// </para>
    /// </summary>
    internal sealed class FeedIndex
    {
        private readonly Dictionary<string, EmonCmsFeed> byId = new(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, EmonCmsFeed> byQualified = new(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, List<EmonCmsFeed>> byName = new(StringComparer.OrdinalIgnoreCase);

        public static FeedIndex Of(IEnumerable<EmonCmsFeed> feeds)
        {
            var index = new FeedIndex();
            foreach (var feed in feeds)
            {
                index.byId[feed.Id] = feed;
                index.byQualified[$"{feed.Tag}/{feed.Name}"] = feed;
                if (!index.byName.TryGetValue(feed.Name, out var list)) index.byName[feed.Name] = list = new();
                list.Add(feed);
            }
            return index;
        }

        /// <summary>The feed, or null with a sentence saying why not.</summary>
        public (EmonCmsFeed? Feed, string Why) Find(string wanted)
        {
            if (byId.TryGetValue(wanted, out var byNumber)) return (byNumber, "");
            if (byQualified.TryGetValue(wanted, out var qualified)) return (qualified, "");

            if (!byName.TryGetValue(wanted, out var named) || named.Count == 0)
                return (null, $"No feed on this EmonCMS server is called '{wanted}' (and none has that id).");

            if (named.Count > 1)
                return (null, $"'{wanted}' names {named.Count} feeds on this server "
                            + $"({string.Join(", ", named.Select(f => $"{f.Tag}/{f.Name}"))}). "
                            + "Qualify it with its tag, or use the feed's numeric id.");

            return (named[0], "");
        }
    }
}
