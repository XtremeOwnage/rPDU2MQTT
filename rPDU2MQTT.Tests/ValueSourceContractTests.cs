using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Core.Integrations;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Services;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// Values reaching the flow from a contributed source, and the rules that keep a stored or stale number
/// from being presented as a live one.
/// </summary>
public class ValueSourceContractTests
{
    private sealed class Fake : IIntegration, IValueSourcePlugin
    {
        public string Id => "fake";
        public string DisplayName => "Fake";
        public IntegrationGroup Group => IntegrationGroup.Integrations;
        public bool Enabled(Config cfg) => true;

        public string SourceType => "fake";
        public string SourceTypeLabel => "Fake source";

        public int Reconciles;
        public IReadOnlyList<SourceBinding> Seen = [];

        public Task ReconcileAsync(Config cfg, IReadOnlyList<SourceBinding> bindings, CancellationToken ct)
        {
            Reconciles++;
            Seen = bindings;
            return Task.CompletedTask;
        }

        public bool TryGetValue(string nodeId, string metric, out double value) { value = 0; return false; }
    }

    private static Config WithBindings()
    {
        var c = new Config();
        var node = new EnergyFlowNode { Id = "shed", Label = "Shed" };
        node.Sources.Add(new EnergyFlowSource { Type = "fake", Metric = "realpower", Settings = { ["Watts"] = "1234" } });
        // A binding of another type must never be handed to this source.
        node.Sources.Add(new EnergyFlowSource { Type = "mqtt", Metric = "energy", Topic = "x/y" });
        c.EnergyFlow.Nodes.Add(node);
        return c;
    }

    [Fact]
    public void ASourceIsHandedItsOwnBindings_AndNobodyElses()
    {
        var bindings = SourceBindings.For(WithBindings(), "fake");

        Assert.Single(bindings);
        Assert.Equal("shed", bindings[0].NodeId);
        Assert.Equal("1234", bindings[0].Setting("Watts"));
        Assert.Equal(1234, bindings[0].Int("Watts"));
    }

    [Fact]
    public void ABindingKnowsTheKeyItsValueIsStoredUnder()
    {
        // The key accounts for direction and accumulation, so a plugin's value is indistinguishable from a
        // built-in ingest's downstream — which is what lets the graph stay ignorant of where it came from.
        var c = new Config();
        var node = new EnergyFlowNode { Id = "batt" };
        node.Sources.Add(new EnergyFlowSource { Type = "fake", Metric = "energy", Direction = "in", Accumulation = "period" });
        c.EnergyFlow.Nodes.Add(node);

        var key = SourceBindings.For(c, "fake")[0].Key();

        Assert.Contains("energytoday", key);   // period accumulation is its own metric
        Assert.EndsWith(FlowMetricKey.InSuffix, key);
    }

    [Fact]
    public async Task AnUnchangedConfigIsNotReAppliedEveryTick()
    {
        // A plugin's ReconcileAsync may open a connection or subscribe; paying that every fifteen seconds
        // because nothing changed would make the contract unusable for anything expensive.
        var fake = new Fake();
        var host = new ValueSourcePluginHost(WithBindings(), new IntegrationRegistry([fake]));

        await host.Reconcile(CancellationToken.None);
        await host.Reconcile(CancellationToken.None);
        await host.Reconcile(CancellationToken.None);

        Assert.Equal(1, fake.Reconciles);
    }

    [Fact]
    public async Task AChangedBindingIsAppliedWithoutARestart()
    {
        var cfg = WithBindings();
        var fake = new Fake();
        var host = new ValueSourcePluginHost(cfg, new IntegrationRegistry([fake]));

        await host.Reconcile(CancellationToken.None);
        cfg.EnergyFlow.Nodes[0].Sources[0].Settings["Watts"] = "999";
        await host.Reconcile(CancellationToken.None);

        Assert.Equal(2, fake.Reconciles);
        Assert.Equal(999, fake.Seen[0].Int("Watts"));
    }

    // --- The history fallback --------------------------------------------------------------------------

    private sealed class StubHistory : IMeasurementHistory
    {
        public Dictionary<string, double> Values = new();
        public int Calls;
        public string Id => "stub";
        public Task<(bool Ok, string Detail)> ProbeAsync(CancellationToken ct) => Task.FromResult((true, "ok"));
        public Task<IReadOnlyDictionary<string, double>> ValuesAtAsync(
            IReadOnlyCollection<string> nodeIds, string metric, DateTime atUtc, CancellationToken ct)
        {
            Calls++;
            return Task.FromResult<IReadOnlyDictionary<string, double>>(
                metric == "realpower" ? Values : new Dictionary<string, double>());
        }
    }

    [Fact]
    public async Task StoredValuesAnswerOnlyAfterAFetch_AndOnlyWhileTheyAreCurrent()
    {
        var history = new StubHistory { Values = { ["solar"] = 4200 } };
        var cfg = new Config();
        cfg.EnergyFlow.Nodes.Add(new EnergyFlowNode { Id = "solar" });

        using var source = new HistoryValueSource(history, cfg, () => ["solar"], TimeSpan.FromMilliseconds(50));

        // Before any fetch it has nothing — never a zero, which would roll up as a real reading.
        Assert.False(source.TryGetValue("solar", "realpower", out _));

        await source.RefreshAsync(CancellationToken.None);
        Assert.True(source.TryGetValue("solar", "realpower", out var v));
        Assert.Equal(4200, v);

        // And it stops answering once its last fetch is older than two refreshes: a value read back from
        // storage is already old, and serving one indefinitely would make a dead backend look healthy.
        await Task.Delay(160);
        Assert.False(source.TryGetValue("solar", "realpower", out _));
    }

    [Fact]
    public async Task AHistoryBackendThatCannotBeRead_LeavesWhatItHad_RatherThanBlanking()
    {
        // Clearing mid-poll would make every node blink to unknown on one bad request.
        var history = new ThrowingHistory();
        var cfg = new Config();
        using var source = new HistoryValueSource(history, cfg, () => ["solar"], TimeSpan.FromMinutes(5));

        await source.RefreshAsync(CancellationToken.None);   // must not throw

        Assert.False(source.TryGetValue("solar", "realpower", out _));
    }

    private sealed class ThrowingHistory : IMeasurementHistory
    {
        public string Id => "throws";
        public Task<(bool Ok, string Detail)> ProbeAsync(CancellationToken ct) => Task.FromResult((false, "no"));
        public Task<IReadOnlyDictionary<string, double>> ValuesAtAsync(
            IReadOnlyCollection<string> nodeIds, string metric, DateTime atUtc, CancellationToken ct)
            => throw new HttpRequestException("unreachable");
    }
}
