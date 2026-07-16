using System.Text.Json;
using Microsoft.Extensions.Hosting;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core;
using rPDU2MQTT.Core.EmonCms;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Models.PDU;

namespace rPDU2MQTT.Services;

/// <summary>
/// Reconciles EmonCMS feeds to match <c>EmonCMS.Feeds</c> (#163): per measurement type it ensures a storage
/// feed exists and the input logs into it (log_to_feed), adds a daily kWh/d feed + step where configured, and
/// optionally creates friendly virtual feeds sourced from the stable storage feeds. Always registered (Worker
/// role) and gated at runtime, so enabling/editing takes effect on the next pass without a restart.
/// </summary>
public sealed class EmonCmsFeedProvisioner : BackgroundService
{
    private static readonly HttpClient http = new() { Timeout = TimeSpan.FromSeconds(20) };
    private readonly Config config;
    private readonly ISnapshotCache snapshots;

    public EmonCmsFeedProvisioner(Config config, ISnapshotCache snapshots)
    {
        this.config = config;
        this.snapshots = snapshots;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Slower than the poll — feed topology changes rarely, and each pass is several API calls.
        var period = TimeSpan.FromSeconds(Math.Max(30, config.Primary.PollInterval * 6));
        using var timer = new PeriodicTimer(period);
        do
        {
            var e = config.EmonCMS;   // read fresh each tick — live-reload the toggle/settings.
            if (e.Enabled && e.Feeds.AutoConfigure && !string.IsNullOrWhiteSpace(e.Url) && !string.IsNullOrWhiteSpace(e.ApiKey))
            {
                try { await ReconcileAsync(stoppingToken); }
                catch (OperationCanceledException) { return; }
                catch (Exception ex) { Log.Warning($"EmonCMS feed provisioning failed: {ex.Message}"); }
            }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    private async Task ReconcileAsync(CancellationToken ct)
    {
        var merged = new PduData();
        foreach (var s in snapshots.All) merged.Devices.AddRange(s.Data.Devices);
        if (merged.Devices.Count == 0) return;

        var p = config.EmonCMS.Feeds.Processes;
        var processes = new EmonProcessIds(string.IsNullOrWhiteSpace(p.LogToFeed) ? "log" : p.LogToFeed.Trim(), p.KwhToKwhd?.Trim(), p.SourceFeed?.Trim());
        var desired = EmonCmsFeedPlanner.BuildDesired(merged, config);

        var inputs = (await GetInputs(ct)).ToDictionary(i => i.Name, StringComparer.OrdinalIgnoreCase);
        var feedByName = (await GetFeeds(ct)).GroupBy(fe => fe.Name, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);

        // 1) Storage + daily feeds.
        foreach (var f in desired.Feeds)
            await EnsureFeed(feedByName, f.Name, f.Tag, f.Engine, f.IntervalSeconds, f.DataType, ct);

        // 2) Input processlists: log_to_feed (+ kwh_to_kwhd for daily).
        foreach (var link in desired.Inputs)
        {
            if (!inputs.TryGetValue(link.InputName, out var input)) continue;   // not posted yet
            if (!feedByName.TryGetValue(link.StorageFeed, out var storage)) continue;
            int? dailyId = link.DailyFeed is { } d && feedByName.TryGetValue(d, out var df) ? df.Id : null;
            if (link.DailyFeed is not null && string.IsNullOrWhiteSpace(processes.KwhToKwhd))
                Log.Warning("EmonCMS: daily feed requested but Feeds.Processes.KwhToKwhd is not set — skipping the kWh/d step.");

            var wanted = EmonCmsFeedPlanner.BuildInputProcessList(storage.Id, dailyId, processes);
            if (!string.Equals(input.ProcessList?.Trim(), wanted, StringComparison.Ordinal))
            {
                await Post("input/process/set.json", new() { ["inputid"] = input.Id.ToString(), ["processlist"] = wanted }, ct);
                Log.Information($"EmonCMS: set processlist for input '{link.InputName}' -> {wanted}.");
            }
        }

        // 3) Virtual feeds: friendly name, sourced from the storage feed.
        foreach (var v in desired.Virtuals)
        {
            if (!feedByName.TryGetValue(v.SourceFeed, out var source)) continue;
            if (string.IsNullOrWhiteSpace(processes.SourceFeed))
            {
                Log.Warning("EmonCMS: virtual feeds enabled but Feeds.Processes.SourceFeed is not set — skipping virtual feeds.");
                break;
            }
            var vfeed = await EnsureFeed(feedByName, v.Name, v.Tag, (int)EmonCmsFeedEngine.VirtualFeed, 0, dataType: 1, ct);
            var wanted = $"{processes.SourceFeed}:{source.Id}";
            if (!string.Equals(vfeed.ProcessList?.Trim(), wanted, StringComparison.Ordinal))
            {
                await Post("feed/process/set.json", new() { ["id"] = vfeed.Id.ToString(), ["processlist"] = wanted }, ct);
                Log.Information($"EmonCMS: virtual feed '{v.Name}' sourced from '{v.SourceFeed}'.");
            }
        }
    }

    private async Task<EmonFeed> EnsureFeed(Dictionary<string, EmonFeed> byName, string name, string tag, int engine, int interval, int dataType, CancellationToken ct)
    {
        if (byName.TryGetValue(name, out var existing)) return existing;
        var id = await CreateFeed(name, tag, engine, interval, dataType, ct);
        var created = new EmonFeed(id, name, tag);
        byName[name] = created;
        Log.Information($"EmonCMS: created feed '{name}' (#{id}, engine {engine}).");
        return created;
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
