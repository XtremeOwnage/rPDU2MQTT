using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Services;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// The service around the integrator: which nodes it samples, what it reports, and — the part that could
/// quietly corrupt data — that a derived figure never displaces a measured one.
/// </summary>
public class EnergyAggregationTests
{
    /// <summary>A source whose readings the test controls.</summary>
    private sealed class Fixed : IFlowValueSource
    {
        public readonly Dictionary<(string, string), double> Values = new();
        public bool TryGetValue(string nodeId, string metric, out double value)
            => Values.TryGetValue((nodeId, metric), out value);
    }

    private static Config ConfigWith(params string[] nodeIds)
    {
        var c = new Config();
        c.EnergyFlow.Aggregation.Enabled = true;
        foreach (var id in nodeIds) c.EnergyFlow.Nodes.Add(new EnergyFlowNode { Id = id, Label = id });
        return c;
    }

    [Fact]
    public void AMeasuredEnergySource_BeatsTheDerivedOne()
    {
        // The precedence that protects real data: the composite takes the first source with a reading, and
        // the aggregator is registered last. A node metered in kWh must keep reporting its meter, not an
        // integral of its own wattage.
        var measured = new Fixed();
        measured.Values[("solar", "energy")] = 91.5;      // a real energy binding
        var derived = new Fixed();
        derived.Values[("solar", "energy")] = 12.0;       // what the aggregator would offer

        var composite = new CompositeFlowValueSource(measured, derived);

        Assert.True(composite.TryGetValue("solar", "energy", out var v));
        Assert.Equal(91.5, v);
    }

    [Fact]
    public void ANodeNeverSampled_ReportsNothing_RatherThanZero()
    {
        // Zero is a claim — "this node used no energy". Absent is the truth when nothing has been measured,
        // and the flow renders absent as "no data" instead of a fabricated total.
        var svc = new EnergyAggregationService(ConfigWith("solar"), new Fixed(), new MemoryEnergyStore());

        Assert.False(svc.TryGetValue("solar", "energy", out _));
    }

    [Fact]
    public void ItOnlyAnswersForEnergy()
    {
        // It derives kWh and nothing else; answering for power would shadow the real reading it integrates.
        var svc = new EnergyAggregationService(ConfigWith("solar"), new Fixed(), new MemoryEnergyStore());
        Assert.False(svc.TryGetValue("solar", "realpower", out _));
        Assert.False(svc.TryGetValue("solar", "voltage", out _));
    }

    [Fact]
    public void TotalsAreCarriedOverFromTheStore()
    {
        // The restart case. The service must continue a count, not restart it — a drop reads downstream as
        // a meter reset and rewrites history that was already correct.
        var store = new MemoryEnergyStore();
        store.Save(new Dictionary<string, EnergyState>
        {
            ["solar"] = new(42.0, new DateTime(2026, 7, 31, 12, 0, 0, DateTimeKind.Utc), 1000, 0),
        });

        var svc = new EnergyAggregationService(ConfigWith("solar"), new Fixed(), store);
        // ExecuteAsync loads on start; drive one cycle and stop.
        using var cts = new CancellationTokenSource(millisecondsDelay: 150);
        try { svc.StartAsync(cts.Token).GetAwaiter().GetResult(); Thread.Sleep(120); } catch (OperationCanceledException) { }

        Assert.True(svc.TryGetValue("solar", "energy", out var v));
        Assert.Equal(42.0, v);   // carried over, not restarted at 0
    }
}
