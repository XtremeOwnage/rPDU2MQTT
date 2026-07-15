using System.Text.Json;
using Microsoft.Extensions.Hosting;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core;
using rPDU2MQTT.Core.EmonCms;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Models.PDU;

namespace rPDU2MQTT.Services;

/// <summary>
/// Keeps EmonCMS feeds in step with the exported inputs (#163): creates a feed per selected measurement,
/// logs the matching input into it, and renames a feed when its source is renamed. Runs periodically in the
/// Worker role when <c>EmonCMS.Feeds.AutoConfigure</c> is on (HTTP transport — a read/write API key is
/// required). Feed values themselves are still produced by the input export; this only manages the feeds.
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
        var period = TimeSpan.FromSeconds(Math.Max(60, config.Primary.PollInterval * 6));
        using var timer = new PeriodicTimer(period);
        do
        {
            var e = config.EmonCMS;
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

        var inputs = await GetInputs(ct);
        var feeds = await GetFeeds(ct);
        var plan = EmonCmsFeedPlanner.Plan(merged, config, inputs, feeds);

        foreach (var rename in plan.Renames)
        {
            await SetFeedName(rename.FeedId, rename.ToName, ct);
            Log.Information($"EmonCMS: renamed feed {rename.FeedId} '{rename.FromName}' -> '{rename.ToName}'.");
        }
        foreach (var link in plan.Links)
        {
            await LogInputToFeed(link.InputId, link.FeedId, InputProcessList(inputs, link.InputId), ct);
            Log.Information($"EmonCMS: logged input '{link.InputName}' into existing feed '{link.FeedName}'.");
        }
        foreach (var create in plan.Creates)
        {
            var feedId = await CreateFeed(create, ct);
            await LogInputToFeed(create.InputId, feedId, InputProcessList(inputs, create.InputId), ct);
            Log.Information($"EmonCMS: created feed '{create.FeedName}' (#{feedId}) and logged input '{create.InputName}'.");
        }
    }

    private static string InputProcessList(IReadOnlyList<EmonInput> inputs, int inputId)
        => inputs.FirstOrDefault(i => i.Id == inputId)?.ProcessList ?? string.Empty;

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
            list.Add(new EmonFeed(GetInt(el, "id"), GetString(el, "name"), el.TryGetProperty("tag", out var t) ? t.GetString() : null));
        return list;
    }

    private async Task<int> CreateFeed(CreateFeed create, CancellationToken ct)
    {
        var options = JsonSerializer.Serialize(new { interval = create.IntervalSeconds });
        using var doc = await GetJson("feed/create.json", new()
        {
            ["tag"] = create.Tag,
            ["name"] = create.FeedName,
            ["engine"] = create.Engine.ToString(),
            ["options"] = options,
        }, ct);
        var root = doc.RootElement;
        if (root.TryGetProperty("success", out var s) && !s.GetBoolean())
            throw new Exception($"feed/create rejected: {root.GetRawText()}");
        return root.TryGetProperty("feedid", out var fid) ? AsInt(fid) : throw new Exception($"feed/create returned no feedid: {root.GetRawText()}");
    }

    private async Task SetFeedName(int feedId, string name, CancellationToken ct)
    {
        var fields = JsonSerializer.Serialize(new { name });
        using var _ = await GetJson("feed/set.json", new() { ["id"] = feedId.ToString(), ["fields"] = fields }, ct);
    }

    private async Task LogInputToFeed(int inputId, int feedId, string existingProcessList, CancellationToken ct)
    {
        var processlist = EmonCmsFeedPlanner.WithLogToFeed(existingProcessList, feedId);
        using var _ = await GetJson("input/process/set.json", new() { ["inputid"] = inputId.ToString(), ["processlist"] = processlist }, ct);
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
