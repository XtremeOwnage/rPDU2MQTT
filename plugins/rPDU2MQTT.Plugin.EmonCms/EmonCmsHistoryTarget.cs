using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.History;
using rPDU2MQTT.Helpers;

namespace rPDU2MQTT.Plugin.EmonCms;

/// <summary>Writes copied history into the feeds the EmonCMS export writes, only where a feed holds nothing in that interval.</summary>
public sealed class EmonCmsHistoryTarget(HttpClient http, Config cfg) : IHistoryTarget
{
    // EmonCMS refuses a read of more than 8928 points; a write is kept to a size a form post takes easily.
    private const int PointsPerWrite = 1000;

    private IReadOnlyDictionary<string, string> feeds = new Dictionary<string, string>();

    public string Id => "emoncms";

    public string? CannotReplace => "EmonCMS has no way to delete a range of points, so replacing would be a delete request for every stored point";

    public string? Unavailable => string.IsNullOrWhiteSpace(cfg.EmonCMS.Url) ? "EmonCMS.Url is not set" : null;

    private string BaseUrl => (cfg.EmonCMS.Url ?? "").TrimEnd('/');
    private string Key => Uri.EscapeDataString(cfg.EmonCMS.ApiKey ?? "");

    public async Task PrepareAsync(CancellationToken ct)
        => feeds = EmonCmsWire.Feeds(await http.GetStringAsync($"{BaseUrl}/feed/list.json?apikey={Key}", ct));

    public async Task<int> WriteAsync(string node, string label, string kind, string metric,
                                      IReadOnlyList<(DateTime At, double Value)> readings, int intervalSeconds, DateTime nowUtc, bool replace, CancellationToken ct)
    {
        if (replace) throw new NotSupportedException(CannotReplace);
        // Feeds are created by provisioning, not here: a series with no feed is not written.
        if (readings.Count == 0 || !feeds.TryGetValue(MetricsHelper.EmonCmsFlowInputName(node, label, kind, metric, cfg), out var id)) return 0;

        var interval = Math.Max(1, intervalSeconds);
        var from = Seconds(readings.Min(r => r.At));
        var to = Seconds(readings.Max(r => r.At)) + interval;
        // The intervals the feed already has a point in; EmonCMS stamps each at the interval's start.
        var held = new HashSet<long>();
        for (var at = from; at < to; at += (long)interval * 8000)
        {
            var end = Math.Min(to, at + (long)interval * 8000);
            var body = await http.GetStringAsync(
                $"{BaseUrl}/feed/data.json?id={id}&start={at * 1000}&end={end * 1000 - 1}&interval={interval}&apikey={Key}", ct);
            foreach (var (ms, _) in EmonCmsWire.Points(body)) held.Add((ms / 1000 - from) / interval);
        }

        var missing = readings.Where(r => double.IsFinite(r.Value) && !held.Contains((Seconds(r.At) - from) / interval))
                              .GroupBy(r => (Seconds(r.At) - from) / interval).Select(g => g.Last()).ToList();
        foreach (var batch in missing.Chunk(PointsPerWrite))
        {
            var data = "[" + string.Join(",", batch.Select(r => $"[{Seconds(r.At)},{r.Value.ToString("R", System.Globalization.CultureInfo.InvariantCulture)}]")) + "]";
            using var response = await http.PostAsync($"{BaseUrl}/feed/insert.json?id={id}&apikey={Key}",
                new FormUrlEncodedContent([new("data", data)]), ct);
            var answer = await response.Content.ReadAsStringAsync(ct);
            if (!response.IsSuccessStatusCode || answer.Contains("\"success\":false", StringComparison.Ordinal))
                throw new HttpRequestException($"EmonCMS refused the write to feed {id}: {answer}");
        }
        return missing.Count;
    }

    private static long Seconds(DateTime at) => new DateTimeOffset(DateTime.SpecifyKind(at, DateTimeKind.Utc)).ToUnixTimeSeconds();
}
