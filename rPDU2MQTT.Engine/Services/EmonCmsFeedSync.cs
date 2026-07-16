using System.Text.Json;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core;
using rPDU2MQTT.Core.EmonCms;
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

    public EmonCmsFeedSync(Config config, ISnapshotCache snapshots)
    {
        this.config = config;
        this.snapshots = snapshots;
    }

    /// <summary>Reconcile using the snapshot cache as the data source (the periodic Worker path).</summary>
    public Task<EmonFeedSyncResult> ReconcileAsync(CancellationToken ct)
    {
        var merged = new PduData();
        foreach (var s in snapshots.All) merged.Devices.AddRange(s.Data.Devices);
        return ReconcileAsync(merged, ct);
    }

    /// <summary>Reconcile against EmonCMS using the supplied PDU data (lets the GUI button pass data it
    /// resolved with a direct-poll fallback, so it works on a UI-only node with a cold cache).</summary>
    public async Task<EmonFeedSyncResult> ReconcileAsync(PduData merged, CancellationToken ct)
    {
        var e = config.EmonCMS;
        if (string.IsNullOrWhiteSpace(e.Url) || string.IsNullOrWhiteSpace(e.ApiKey))
            return new(false, "EmonCMS Url and a read/write ApiKey are required for feed provisioning.");
        if (e.Feeds.Types is null || e.Feeds.Types.Count == 0)
            return new(false, "No feed Types configured — add at least one measurement type.");
        if (merged.Devices.Count == 0)
            return new(false, "No PDU data yet — wait for the first poll, then try again.");

        var p = e.Feeds.Processes;
        var processes = new EmonProcessIds(string.IsNullOrWhiteSpace(p.LogToFeed) ? "log" : p.LogToFeed.Trim(), p.KwhToKwhd?.Trim(), p.SourceFeed?.Trim());
        var desired = EmonCmsFeedPlanner.BuildDesired(merged, config);

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
            if (!feedByName.TryGetValue(link.StorageFeed, out var storage)) continue;   // its feed failed to create
            int? dailyId = link.DailyFeed is { } d && feedByName.TryGetValue(d, out var df) ? df.Id : null;

            var wanted = EmonCmsFeedPlanner.BuildInputProcessList(storage.Id, dailyId, processes);
            if (!string.Equals(input.ProcessList?.Trim(), wanted, StringComparison.Ordinal))
                try
                {
                    await Post("input/process/set.json", new() { ["inputid"] = input.Id.ToString(), ["processlist"] = wanted }, ct);
                    Log.Information($"EmonCMS: set processlist for input '{link.InputName}' -> {wanted}.");
                    processesSet++;
                }
                catch (Exception ex) { errors.Add($"processlist '{link.InputName}': {ex.Message}"); }
        }

        // 3) Virtual feeds: friendly name, sourced from the storage feed.
        if (desired.Virtuals.Count > 0 && string.IsNullOrWhiteSpace(processes.SourceFeed))
            Log.Warning("EmonCMS: virtual feeds enabled but Feeds.Processes.SourceFeed is not set — skipping.");
        else
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
                    var wanted = $"{processes.SourceFeed}:{source.Id}";
                    if (!string.Equals(vfeed.ProcessList?.Trim(), wanted, StringComparison.Ordinal))
                    {
                        await Post("feed/process/set.json", new() { ["id"] = vfeed.Id.ToString(), ["processlist"] = wanted }, ct);
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
            list.Add(new EmonInput(GetInt(el, "id"), GetString(el, "name"), GetString(el, "processList")));
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

    private async Task Post(string path, Dictionary<string, string> query, CancellationToken ct)
    {
        using var _ = await GetJson(path, query, ct);
    }

    private async Task<JsonDocument> GetJson(string path, Dictionary<string, string>? query, CancellationToken ct)
    {
        var url = $"{config.EmonCMS.Url!.TrimEnd('/')}/{path}?apikey={Uri.EscapeDataString(config.EmonCMS.ApiKey ?? string.Empty)}";
        if (query is not null)
            foreach (var (k, v) in query) url += $"&{k}={Uri.EscapeDataString(v)}";

        using var resp = await http.GetAsync(url, ct);
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
