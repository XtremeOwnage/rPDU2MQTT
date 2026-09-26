using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Core.History;

namespace rPDU2MQTT.Integrations.Local;

/// <summary>
/// History the bridge keeps itself, in a directory of fixed-interval files (#502).
///
/// <para>
/// The other backends are network services: a read is HTTP, authentication, and — on EmonCMS — a request
/// per node, because it has no endpoint that takes a set. This one is a seek into a local file, so a window
/// over every node costs what reading a few kilobytes costs, and it needs nothing installed beside the
/// bridge. What it stores is written by <c>LocalHistoryWriterService</c> on the same sweep that already
/// reads every node.
/// </para>
/// </summary>
public sealed class LocalFlowHistory(Config cfg, LocalSeriesStore store) : IMeasurementHistory
{
    public string Id => "local";

    public LocalSeriesStore Store { get; } = store;

    public Task<IReadOnlyDictionary<string, double>> ValuesAtAsync(
        IReadOnlyCollection<string> nodeIds, string metric, DateTime atUtc, CancellationToken ct)
    {
        var found = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);
        foreach (var node in nodeIds)
        {
            ct.ThrowIfCancellationRequested();
            var value = Store.ValueAt(node, metric, atUtc);
            if (!double.IsNaN(value)) found[node] = value;
        }
        return Task.FromResult<IReadOnlyDictionary<string, double>>(found);
    }

    public Task<IReadOnlyList<IReadOnlyDictionary<string, double>>> SeriesAsync(
        IReadOnlyCollection<string> nodeIds, string metric, IReadOnlyList<DateTime> steps, CancellationToken ct)
    {
        var perStep = steps.Select(_ => new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase)).ToList();
        foreach (var node in nodeIds)
        {
            ct.ThrowIfCancellationRequested();
            var values = Store.Series(node, metric, steps);
            for (var i = 0; i < values.Length; i++)
                if (!double.IsNaN(values[i])) perStep[i][node] = values[i];
        }
        return Task.FromResult<IReadOnlyList<IReadOnlyDictionary<string, double>>>(
            perStep.Cast<IReadOnlyDictionary<string, double>>().ToList());
    }

    /// <summary>Is the directory there, writable, and holding anything yet?</summary>
    public Task<(bool Ok, string Detail)> ProbeAsync(CancellationToken ct)
    {
        var root = Store.Root;
        try
        {
            Directory.CreateDirectory(root);
            // Writable is the thing that actually fails in a container: a read-only mount looks fine until
            // the first sweep, and then nothing is ever stored.
            var probe = Path.Combine(root, ".writable");
            File.WriteAllText(probe, "ok");
            File.Delete(probe);
        }
        catch (Exception ex) { return Task.FromResult((false, $"{root} cannot be written to: {ex.Message}")); }

        var series = Store.Folders().Count;
        var megabytes = Size(root) / 1024d / 1024d;
        return Task.FromResult((true, series == 0
            ? $"{root} is ready, with nothing stored yet — the first readings arrive within {cfg.EnergyFlow.Aggregation.SampleIntervalSeconds}s"
            : $"{root} · {series} series · {megabytes:0.#} MB"));
    }

    private static long Size(string root)
    {
        try { return new DirectoryInfo(root).EnumerateFiles("*.rts", SearchOption.AllDirectories).Sum(f => f.Length); }
        catch (IOException) { return 0; }
        catch (UnauthorizedAccessException) { return 0; }
    }
}
