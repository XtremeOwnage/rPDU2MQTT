using Microsoft.Extensions.DependencyInjection;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Core.History;
using rPDU2MQTT.Integrations.Local;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Services;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// The bridge storing its own readings and reading them back (#502): what the sweep writes is what the
/// Flow and Trends pages get, with no other service in between.
/// </summary>
public class LocalHistoryProviderTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "rpdu-history-" + Guid.NewGuid().ToString("N")[..8]);

    public void Dispose()
    {
        try { if (Directory.Exists(root)) Directory.Delete(root, recursive: true); } catch (IOException) { }
    }

    /// <summary>What the nodes are reading at the moment of a sweep.</summary>
    private sealed class Live(Dictionary<string, double> values) : IFlowValueSource
    {
        public Dictionary<string, double> Values { get; } = values;
        public bool TryGetValue(string node, string metric, out double value) => Values.TryGetValue(node + "|" + metric, out value);
    }

    private static Config Configured(string root)
    {
        var cfg = new Config();
        cfg.History.Enabled = true;
        cfg.History.Provider = "local";
        cfg.History.LocalPath = root;
        cfg.EnergyFlow.Nodes.Add(new() { Id = "grid", Kind = "grid" });
        cfg.EnergyFlow.Nodes.Add(new() { Id = "main", Kind = "panel" });
        cfg.EnergyFlow.Links.Add(new() { From = "grid", To = "main" });
        return cfg;
    }

    private static DateTime At(int minute, int second = 0) => new(2026, 9, 20, 10, minute, second, DateTimeKind.Utc);

    [Fact]
    public async Task ASweepStoresWhatEachNodeIsReading_AndTheReadGivesItBack()
    {
        var cfg = Configured(root);
        var live = new Live(new() { ["grid|realpower"] = 800, ["main|realpower"] = 780, ["main|energy"] = 1234.5 });
        var store = new LocalSeriesStore(root, rawIntervalSeconds: 10);
        var writer = new LocalHistoryWriterService(cfg, live, store);
        var history = new LocalFlowHistory(cfg, store);

        var stored = writer.Sweep(At(0));

        Assert.Equal(3, stored);
        var found = await history.ValuesAtAsync(["grid", "main"], "realpower", At(0), CancellationToken.None);
        Assert.Equal(800, found["grid"]);
        Assert.Equal(780, found["main"]);
        // …and each metric is a series of its own.
        var energy = await history.ValuesAtAsync(["main"], "energy", At(0), CancellationToken.None);
        Assert.Equal(1234.5, energy["main"]);
    }

    [Fact]
    public async Task ANodeReadingNothingIsNotStored_SoItIsNotReadBackAsAZero()
    {
        var cfg = Configured(root);
        var live = new Live(new() { ["grid|realpower"] = 800 });
        var store = new LocalSeriesStore(root, rawIntervalSeconds: 10);
        new LocalHistoryWriterService(cfg, live, store).Sweep(At(0));

        var found = await new LocalFlowHistory(cfg, store).ValuesAtAsync(["grid", "main"], "realpower", At(0), CancellationToken.None);

        Assert.Equal(800, found["grid"]);
        Assert.False(found.ContainsKey("main"));
    }

    [Fact]
    public async Task EverySweepIsItsOwnStep_SoAWindowIsWhatEachNodeWasDoing()
    {
        var cfg = Configured(root);
        var live = new Live(new() { ["grid|realpower"] = 100 });
        var store = new LocalSeriesStore(root, rawIntervalSeconds: 60);
        var writer = new LocalHistoryWriterService(cfg, live, store);
        var steps = new List<DateTime>();
        for (var i = 0; i < 5; i++)
        {
            live.Values["grid|realpower"] = 100 * (i + 1);
            writer.Sweep(At(i));
            steps.Add(At(i));
        }

        var series = await new LocalFlowHistory(cfg, store).SeriesAsync(["grid"], "realpower", steps, CancellationToken.None);

        Assert.Equal([100d, 200, 300, 400, 500], series.Select(s => s["grid"]).ToArray());
    }

    /// <summary>
    /// Everything the build understands is recorded, not a list someone retyped: a metric added to the
    /// bridge and left out here would be missing from the history with nothing to say so.
    /// </summary>
    [Fact]
    public void EveryMetricTheBridgeUnderstandsIsStored()
    {
        var cfg = Configured(root);
        // One of each, all on the same node.
        var live = new Live(rPDU2MQTT.Core.Flow.FlowUnits.Metrics
            .Select((m, i) => (m, i)).ToDictionary(x => $"grid|{x.m}", x => (double)(x.i + 1)));
        var store = new LocalSeriesStore(root, rawIntervalSeconds: 10);

        var stored = new LocalHistoryWriterService(cfg, live, store).Sweep(At(0));

        Assert.Equal(rPDU2MQTT.Core.Flow.FlowUnits.Metrics.Length, stored);
        foreach (var (metric, i) in rPDU2MQTT.Core.Flow.FlowUnits.Metrics.Select((m, i) => (m, i)))
            Assert.Equal(i + 1, store.ValueAt("grid", metric, At(0), At(1)));
        // …including the ones a hardcoded list forgot: the power factor, a percentage, a temperature.
        foreach (var metric in new[] { "powerfactor", "percent", "temperature" })
            Assert.False(double.IsNaN(store.ValueAt("grid", metric, At(0), At(1))), $"{metric} was not stored");
    }

    /// <summary>A battery's charge and a grid's export are stored as their own series, as they are exported.</summary>
    [Fact]
    public async Task TheReturnLaneIsASeriesOfItsOwn()
    {
        var cfg = Configured(root);
        var live = new Live(new() { ["grid|realpower"] = 0, ["grid|realpower#in"] = 450 });
        var store = new LocalSeriesStore(root, rawIntervalSeconds: 10);
        new LocalHistoryWriterService(cfg, live, store).Sweep(At(0));

        var found = await new LocalFlowHistory(cfg, store)
            .ValuesAtAsync(["grid", "grid#in"], "realpower", At(0), CancellationToken.None);

        Assert.Equal(0, found["grid"]);
        Assert.Equal(450, found["grid#in"]);
    }

    /// <summary>
    /// Recording is a destination, not a backend. A store only written while it is also the chosen backend
    /// is empty on the day someone switches to it — which is the day they want a year of readings.
    /// </summary>
    [Fact]
    public void ReadingsAreKeptWhateverThePagesAreReadingFrom()
    {
        var cfg = Configured(root);
        cfg.History.Provider = "prometheus";
        var store = new LocalSeriesStore(root, rawIntervalSeconds: 10);
        var live = new Live(new() { ["grid|realpower"] = 800 });

        var stored = new LocalHistoryWriterService(cfg, live, store).Sweep(At(0));

        Assert.Equal(1, stored);
        Assert.Equal(800, store.ValueAt("grid", "realpower", At(0), At(1)));
        // …while the pages still read from the backend that was chosen.
        Assert.Equal("prometheus", new FlowHistoryRouter(new HttpClient(), cfg, store).Id);
    }

    [Fact]
    public void TurningTheStoreOffIsWhatStopsItRecording()
    {
        var cfg = Configured(root);
        cfg.History.LocalEnabled = false;
        var store = new LocalSeriesStore(root, rawIntervalSeconds: 10);
        var writer = new LocalHistoryWriterService(cfg, new Live(new() { ["grid|realpower"] = 800 }), store);

        // The service does nothing at all while it is off; the sweep is what a test drives directly.
        Assert.False(writer.Recording);
        cfg.History.LocalEnabled = true;
        Assert.True(writer.Recording);
    }

    /// <summary>
    /// The registration built for real. A history writer asking for something nobody registered would only
    /// be found at boot — in a crash loop — and the container is the one part no unit test otherwise sees.
    /// </summary>
    [Fact]
    public void TheContainerBuildsTheStore_TheRouterAndTheWriter()
    {
        var cfg = Configured(root);
        var services = new Microsoft.Extensions.DependencyInjection.ServiceCollection();
        // What the writer reads from: registered by the rest of the graph in the real host.
        services.AddSingleton<IFlowValueSource>(new Live(new()));
        rPDU2MQTT.Startup.ServiceConfiguration.AddHistory(services, cfg);

        using var provider = services.BuildServiceProvider(new Microsoft.Extensions.DependencyInjection.ServiceProviderOptions
        {
            ValidateOnBuild = true,
            ValidateScopes = true,
        });

        Assert.Equal(root, provider.GetRequiredService<LocalSeriesStore>().Root);
        Assert.Equal("local", provider.GetRequiredService<IMeasurementHistory>().Id);
        Assert.Contains(provider.GetServices<Microsoft.Extensions.Hosting.IHostedService>(), s => s is LocalHistoryWriterService);
    }

    [Fact]
    public async Task TheProbeSaysWhereItIsKeptAndWhetherItCanBeWrittenTo()
    {
        var cfg = Configured(root);
        var store = new LocalSeriesStore(root);
        var history = new LocalFlowHistory(cfg, store);

        var (ok, detail) = await history.ProbeAsync(CancellationToken.None);

        Assert.True(ok);
        Assert.Contains(root, detail);
        Assert.Contains("nothing stored yet", detail);

        new LocalHistoryWriterService(cfg, new Live(new() { ["grid|realpower"] = 5 }), store).Sweep(At(0));
        var (okAgain, withSeries) = await history.ProbeAsync(CancellationToken.None);
        Assert.True(okAgain);
        Assert.Contains("1 series", withSeries);
    }
}
