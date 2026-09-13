using System.Text.Json;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core;
using rPDU2MQTT.Integrations.EmonCms;
using rPDU2MQTT.Helpers;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Models.PDU;

namespace rPDU2MQTT.Services;

/// <summary>The outcome of a feed-provisioning pass, surfaced to the GUI's manual trigger.</summary>
public sealed record EmonFeedSyncResult(bool Ok, string Message, int FeedsCreated = 0, int ProcessesSet = 0, int VirtualFeeds = 0);

/// <summary>
/// Reconciles EmonCMS feeds to match <c>EmonCMS.Feeds</c> (#163) — creating storage/daily/virtual feeds and
/// setting input processlists. Shared by the periodic <see cref="EmonCmsFeedProvisioner"/> and the GUI's
/// "Provision now" button, and returns a summary so the UI can show what happened.
/// </summary>
public sealed class EmonCmsFeedSync
{
    private static readonly HttpClient http = new() { Timeout = TimeSpan.FromSeconds(20) };
    private readonly Config config;
    private readonly ISnapshotCache snapshots;
    private readonly Core.Flow.IFlowValueSource? live;

    public EmonCmsFeedSync(Config config, ISnapshotCache snapshots, Core.Flow.IFlowValueSource? live = null)
    {
        this.config = config;
        this.snapshots = snapshots;
        this.live = live;
    }

    /// <summary>Every cached snapshot's devices, as one set of PDU data.</summary>
    public PduData Merged()
    {
        var merged = new PduData();
        foreach (var s in snapshots.All) merged.Devices.AddRange(s.Data.Devices);
        return merged;
    }

    /// <summary>The PDU instance each cached device was polled from, keyed by device name.</summary>
    private Dictionary<string, string> Instances()
    {
        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var s in snapshots.All) foreach (var d in s.Data.Devices) map[d.Entity_Name] = s.InstanceId;
        return map;
    }

    /// <summary>Reconcile using the snapshot cache as the data source (the periodic Worker path).</summary>
    public Task<EmonFeedSyncResult> ReconcileAsync(CancellationToken ct) => ReconcileAsync(Merged(), ct);

    /// <summary>Reconcile against EmonCMS using the supplied PDU data (lets the GUI button pass data it
    /// resolved with a direct-poll fallback, so it works on a UI-only node with a cold cache).</summary>
    public async Task<EmonFeedSyncResult> ReconcileAsync(PduData merged, CancellationToken ct)
    {
        var e = config.EmonCMS;
        if (string.IsNullOrWhiteSpace(e.Url) || string.IsNullOrWhiteSpace(e.ApiKey))
            return new(false, "EmonCMS Url and a read/write ApiKey are required for feed provisioning.");
        if (e.Feeds.Types is null || e.Feeds.Types.Count == 0)
            return new(false, "No feed Types configured — add at least one measurement type.");
        // A hierarchy of virtual nodes is provisionable on its own — an install can have inverters and
        // batteries modelled and no PDU at all.
        if (!Core.Flow.FlowTiers.Any(merged, config))
            return new(false, "No PDU data yet — wait for the first poll, then try again.");

        var flow = config.EmonCMS.ExportFlowNodes ? Core.Flow.FlowTiers.Graphs(merged, config, live) : null;
        var desired = EmonCmsFeedPlanner.BuildDesired(merged, config, flow, Instances());

        var inputList = await GetInputs(ct);
        var inputs = inputList.ToDictionary(i => i.Name, StringComparer.OrdinalIgnoreCase);
        var feedByName = (await GetFeeds(ct)).GroupBy(fe => fe.Name, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);

        int created = 0, processesSet = 0, virtuals = 0;
        var errors = new List<string>();

        // 1) Storage + daily feeds. Keep going if one fails (e.g. a server-side engine/permission error)
        //    so the rest still get provisioned and every failure is reported.
        foreach (var f in desired.Feeds)
            try { if (await EnsureFeed(feedByName, f.Name, f.Tag, f.Engine, f.IntervalSeconds, f.DataType, ct)) created++; }
            catch (Exception ex) { errors.Add($"feed '{f.Name}': {ex.Message}"); }

        // 2) Input processlists: log_to_feed (+ kwh_to_kwhd for daily).
        var missingInputs = 0;
        foreach (var link in desired.Inputs)
        {
            if (!inputs.TryGetValue(link.InputName, out var input)) { missingInputs++; continue; }
            if (!feedByName.ContainsKey(link.StorageFeed)) continue;   // its feed failed to create

            var wanted = EmonCmsFeedPlanner.BuildInputProcessList(link.Steps,
                name => feedByName.TryGetValue(name, out var fd) ? fd.Id : null);
            if (wanted.Length == 0) continue;
            if (!string.Equals(input.ProcessList?.Trim(), wanted, StringComparison.Ordinal))
                try
                {
                    await PostForm("input/process/set.json", new() { ["inputid"] = input.Id.ToString() }, new() { ["processlist"] = wanted }, ct);
                    Log.Information($"EmonCMS: set processlist for input '{link.InputName}' -> {wanted}.");
                    processesSet++;
                }
                catch (Exception ex) { errors.Add($"processlist '{link.InputName}': {ex.Message}"); }
        }

        // 3) Virtual feeds: friendly name, sourced from the storage feed.
        foreach (var v in desired.Virtuals)
        {
            if (!feedByName.TryGetValue(v.SourceFeed, out var source)) continue;
            try
            {
                if (!feedByName.TryGetValue(v.Name, out var vfeed))
                {
                    var id = await CreateFeed(v.Name, v.Tag, (int)EmonCmsFeedEngine.VirtualFeed, 0, 1, ct);
                    vfeed = new EmonFeed(id, v.Name, v.Tag);
                    feedByName[v.Name] = vfeed;
                    created++;
                    Log.Information($"EmonCMS: created virtual feed '{v.Name}' (#{id}).");
                }
                var wanted = $"{ProcessSlot.SourceFeed}:{source.Id}";
                if (!string.Equals(vfeed.ProcessList?.Trim(), wanted, StringComparison.Ordinal))
                {
                    await PostForm("feed/process/set.json", new() { ["id"] = vfeed.Id.ToString() }, new() { ["processlist"] = wanted }, ct);
                    virtuals++;
                }
            }
            catch (Exception ex) { errors.Add($"virtual feed '{v.Name}': {ex.Message}"); }
        }

        var msg = $"Created {created} feed(s), set {processesSet} processlist(s), wired {virtuals} virtual feed(s).";
        if (missingInputs > 0)
            msg += $" {missingInputs} input(s) not in EmonCMS yet — check the EmonCMS export is enabled and posting.";
        if (errors.Count > 0)
            msg += $" {errors.Count} failed: {string.Join(" | ", errors.Take(3))}{(errors.Count > 3 ? " …" : "")}";
        return new(errors.Count == 0, msg, created, processesSet, virtuals);
    }

    /// <summary>Delete every feed filed under rPDU2MQTT's tag(s) — the storage tag and, if different, the
    /// virtual-feed tag. Returns how many were deleted.</summary>
    public async Task<EmonFeedSyncResult> DeleteAllAsync(CancellationToken ct)
    {
        var e = config.EmonCMS;
        if (string.IsNullOrWhiteSpace(e.Url) || string.IsNullOrWhiteSpace(e.ApiKey))
            return new(false, "EmonCMS Url and a read/write ApiKey are required.");

        var tags = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            string.IsNullOrWhiteSpace(e.Feeds.Tag) ? e.Node : e.Feeds.Tag!,
        };
        if (!string.IsNullOrWhiteSpace(e.Feeds.Virtual.Tag)) tags.Add(e.Feeds.Virtual.Tag!);
        // Per-node and per-PDU tags, as the current plan files feeds under them.
        var merged = Merged();
        if (Core.Flow.FlowTiers.Any(merged, config))
        {
            var planned = EmonCmsFeedPlanner.BuildDesired(merged, config, e.ExportFlowNodes ? Core.Flow.FlowTiers.Graphs(merged, config, live) : null, Instances());
            foreach (var t in planned.Feeds.Select(x => x.Tag).Concat(planned.Virtuals.Select(x => x.Tag))) tags.Add(t);
        }

        int deleted = 0; var errors = new List<string>();
        foreach (var f in (await GetFeeds(ct)).Where(f => tags.Contains(f.Tag ?? "")))
            try { await PostForm("feed/delete.json", new() { ["id"] = f.Id.ToString() }, new(), ct); deleted++; }
            catch (Exception ex) { errors.Add($"feed '{f.Name}': {ex.Message}"); }

        var msg = $"Deleted {deleted} feed(s) under tag(s) {string.Join(", ", tags)}.";
        if (errors.Count > 0) msg += $" {errors.Count} failed: {string.Join(" | ", errors.Take(3))}";
        return new(errors.Count == 0, msg, deleted);
    }

    /// <summary>The inputs under this bridge's node(s) it no longer sends, and the feeds under its tags it no longer provisions.</summary>
    public async Task<EmonStalePlan> FindStaleAsync(PduData merged, CancellationToken ct)
    {
        var e = config.EmonCMS;
        if (string.IsNullOrWhiteSpace(e.Url) || string.IsNullOrWhiteSpace(e.ApiKey))
            return new([], [], "EmonCMS Url and a read/write ApiKey are required.");
        if (!Core.Flow.FlowTiers.Any(merged, config))
            return new([], [], "No PDU data yet — wait for the first poll, then try again.");

        // Input names as the export sends them: every reading, and every flow tier for each exported metric.
        var posted = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var r in MetricsHelper.EnumerateReadings(merged)) posted.Add(MetricsHelper.EmonCmsInputName(r, config));
        var flow = e.ExportFlowNodes ? Core.Flow.FlowTiers.Graphs(merged, config, live) : null;
        foreach (var (metric, graph) in flow ?? [])
            foreach (var t in Core.Flow.FlowTiers.Of(graph, e.NodeTags))
                posted.Add(MetricsHelper.EmonCmsFlowInputName(t.Node.Id, t.Node.Label, t.Node.Kind, metric, config));

        // The node inputs arrive under: the configured one, and each PDU's own when MQTT splits by device.
        var nodes = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { e.Node };
        if (e.Transport == EmonCmsTransport.Mqtt && MetricsHelper.EmonCmsSplitsByDevice(config))
            foreach (var r in MetricsHelper.EnumerateReadings(merged)) nodes.Add(r.Device);

        // Every tag the plan files feeds under is this bridge's, so per-node and per-PDU tags are covered too.
        var desired = EmonCmsFeedPlanner.BuildDesired(merged, config, flow, Instances());
        var storageTags = new HashSet<string>(desired.Feeds.Select(x => x.Tag), StringComparer.OrdinalIgnoreCase)
            { string.IsNullOrWhiteSpace(e.Feeds.Tag) ? e.Node : e.Feeds.Tag! };
        var virtualTags = new HashSet<string>(desired.Virtuals.Select(x => x.Tag), StringComparer.OrdinalIgnoreCase);
        if (!string.IsNullOrWhiteSpace(e.Feeds.Virtual.Tag)) virtualTags.Add(e.Feeds.Virtual.Tag!);
        return EmonCmsFeedPlanner.Stale(posted, nodes, desired, await GetInputs(ct), await GetFeeds(ct), storageTags, virtualTags);
    }

    /// <summary>Delete the stale inputs, feeds, or both, as <see cref="FindStaleAsync"/> finds them now.</summary>
    public async Task<EmonFeedSyncResult> DeleteStaleAsync(PduData merged, bool inputs, bool feeds, CancellationToken ct)
    {
        var plan = await FindStaleAsync(merged, ct);
        if (plan.Refused is not null) return new(false, plan.Refused);

        int inputsDeleted = 0, feedsDeleted = 0;
        var errors = new List<string>();
        if (inputs)
            foreach (var i in plan.Inputs)
                try { await PostForm("input/delete.json", new() { ["inputid"] = i.Id.ToString() }, new(), ct); inputsDeleted++; }
                catch (Exception ex) { errors.Add($"input '{i.Node}/{i.Name}': {ex.Message}"); }
        if (feeds)
            foreach (var f in plan.Feeds)
                try { await PostForm("feed/delete.json", new() { ["id"] = f.Id.ToString() }, new(), ct); feedsDeleted++; }
                catch (Exception ex) { errors.Add($"feed '{f.Tag}/{f.Name}': {ex.Message}"); }

        var parts = new List<string>();
        if (inputs) parts.Add($"deleted {inputsDeleted} old input(s)");
        if (feeds) parts.Add($"deleted {feedsDeleted} old feed(s)");
        var msg = char.ToUpperInvariant(string.Join(" and ", parts)[0]) + string.Join(" and ", parts)[1..] + ".";
        if (errors.Count > 0) msg += $" {errors.Count} failed: {string.Join(" | ", errors.Take(3))}";
        Log.Information($"EmonCMS cleanup: {msg}");
        return new(errors.Count == 0, msg, feedsDeleted);
    }

    private async Task<bool> EnsureFeed(Dictionary<string, EmonFeed> byName, string name, string tag, int engine, int interval, int dataType, CancellationToken ct)
    {
        if (byName.ContainsKey(name)) return false;
        var id = await CreateFeed(name, tag, engine, interval, dataType, ct);
        byName[name] = new EmonFeed(id, name, tag);
        Log.Information($"EmonCMS: created feed '{name}' (#{id}, engine {engine}).");
        return true;
    }

    // ---- EmonCMS API ---------------------------------------------------------------------------------

    private async Task<List<EmonInput>> GetInputs(CancellationToken ct)
    {
        using var doc = await GetJson("input/list.json", null, ct);
        var list = new List<EmonInput>();
        foreach (var el in doc.RootElement.EnumerateArray())
            list.Add(new EmonInput(GetInt(el, "id"), GetString(el, "name"), GetString(el, "processList"), GetString(el, "nodeid")));
        return list;
    }

    private async Task<List<EmonFeed>> GetFeeds(CancellationToken ct)
    {
        using var doc = await GetJson("feed/list.json", null, ct);
        var list = new List<EmonFeed>();
        foreach (var el in doc.RootElement.EnumerateArray())
            list.Add(new EmonFeed(GetInt(el, "id"), GetString(el, "name"),
                el.TryGetProperty("tag", out var t) ? t.GetString() : null,
                el.TryGetProperty("processList", out var pl) ? pl.GetString() : null));
        return list;
    }

    private async Task<int> CreateFeed(string name, string tag, int engine, int interval, int dataType, CancellationToken ct)
    {
        var query = new Dictionary<string, string>
        {
            ["tag"] = tag,
            ["name"] = name,
            ["datatype"] = dataType.ToString(),
            ["engine"] = engine.ToString(),
        };
        if (interval > 0)
            query["options"] = JsonSerializer.Serialize(new { interval });
        using var doc = await GetJson("feed/create.json", query, ct);
        var root = doc.RootElement;
        if (root.TryGetProperty("success", out var s) && !s.GetBoolean())
            throw new Exception($"feed/create rejected: {root.GetRawText()}");
        return root.TryGetProperty("feedid", out var fid) ? AsInt(fid) : throw new Exception($"feed/create returned no feedid: {root.GetRawText()}");
    }

    private string Url(string path, Dictionary<string, string>? query)
    {
        var url = $"{config.EmonCMS.Url!.TrimEnd('/')}/{path}?apikey={Uri.EscapeDataString(config.EmonCMS.ApiKey ?? string.Empty)}";
        if (query is not null)
            foreach (var (k, v) in query) url += $"&{k}={Uri.EscapeDataString(v)}";
        return url;
    }

    /// <summary>
    /// input/process/set and feed/process/set only take effect as a POST with the processlist in the body
    /// (a GET silently no-ops, returning "processlist was not updated") — verified against a live EmonCMS.
    /// Identifiers (inputid/id/apikey) go in the query; the mutated fields go in the form.
    /// </summary>
    private async Task PostForm(string path, Dictionary<string, string> query, Dictionary<string, string> form, CancellationToken ct)
    {
        using var content = new FormUrlEncodedContent(form);
        using var resp = await http.PostAsync(Url(path, query), content, ct);
        var body = await resp.Content.ReadAsStringAsync(ct);
        if (!resp.IsSuccessStatusCode)
            throw new Exception($"HTTP {(int)resp.StatusCode} from {path}: {body}");
        var doc = JsonDocument.Parse(body);
        // Answers 200 even on rejection; the failure is in the body ({"success":false,"message":...}).
        if (doc.RootElement.ValueKind == JsonValueKind.Object && doc.RootElement.TryGetProperty("success", out var s) && s.ValueKind == JsonValueKind.False)
            throw new Exception(doc.RootElement.TryGetProperty("message", out var m) ? (m.GetString() ?? body) : body);
    }

    private async Task<JsonDocument> GetJson(string path, Dictionary<string, string>? query, CancellationToken ct)
    {
        using var resp = await http.GetAsync(Url(path, query), ct);
        var body = await resp.Content.ReadAsStringAsync(ct);
        if (!resp.IsSuccessStatusCode)
            throw new Exception($"HTTP {(int)resp.StatusCode} from {path}: {body}");
        return JsonDocument.Parse(body);
    }

    private static string GetString(JsonElement el, string prop)
        => el.TryGetProperty(prop, out var v) ? (v.ValueKind == JsonValueKind.String ? v.GetString() ?? string.Empty : v.ToString()) : string.Empty;

    private static int GetInt(JsonElement el, string prop) => el.TryGetProperty(prop, out var v) ? AsInt(v) : 0;

    private static int AsInt(JsonElement v)
        => v.ValueKind == JsonValueKind.Number ? v.GetInt32()
         : int.TryParse(v.GetString(), out var i) ? i : 0;
}
