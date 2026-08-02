using rPDU2MQTT.Core.Flow;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// Counters the device resets each day, as opposed to cumulative ones. One publisher does both — Solar
/// Assistant's <c>total/load_energy</c> is cumulative while <c>total/pv_energy</c> rolls over at midnight —
/// so which it is cannot be inferred and has to be declared.
/// </summary>
public class PeriodAccumulationTests
{
    [Fact]
    public void ADailyCounter_IsStoredAsTheDailyTotal_NotAsLifetimeEnergy()
    {
        // The reading already IS today's total, so it goes straight to the metric that means that. Measuring
        // its "rise" instead is what reported 2.76 kWh of solar against 27.4 kWh actually generated: the
        // counter dropped to zero at midnight and climbed again unobserved, and the next reading was
        // measured against yesterday's high-water mark.
        Assert.Equal(EnergyPeriod.Metric, FlowMetricKey.ForAccumulation("energy", "period"));
        Assert.Equal("energy", FlowMetricKey.ForAccumulation("energy", "lifetime"));
        Assert.Equal("energy", FlowMetricKey.ForAccumulation("energy", null));
    }

    [Fact]
    public void OnlyEnergyAccumulates()
    {
        // Power, current and the rest are instantaneous — there is no counter to reset, so the setting is
        // meaningless for them and must not silently redirect them somewhere strange.
        Assert.Equal("realpower", FlowMetricKey.ForAccumulation("realpower", "period"));
        Assert.Equal("voltage", FlowMetricKey.ForAccumulation("voltage", "period"));
        Assert.Equal("soc", FlowMetricKey.ForAccumulation("soc", "period"));
    }

    [Fact]
    public void ADailyCounter_StillSplitsIntoBothDirections()
    {
        // A battery publishing separate daily charge/discharge totals must keep them apart, exactly as the
        // cumulative pair does.
        var keys = FlowMetricKey.Keys(FlowMetricKey.ForAccumulation("energy", "period"), "in").ToList();
        Assert.Equal(new[] { EnergyPeriod.Metric + FlowMetricKey.InSuffix }, keys);

        var fanned = FlowMetricKey.Fan(FlowMetricKey.ForAccumulation("energy", "period"), "out", 27.4).ToList();
        Assert.Equal(EnergyPeriod.Metric, fanned.Single().Key);
        Assert.Equal(27.4, fanned.Single().Value);
    }

    [Fact]
    public void TheDeclaredDailyFigure_ReachesTheGraph_AndIsNotOverriddenByADerivedOne()
    {
        // A real reading always beats a computed one: the composite takes the first source with a value and
        // the derived accumulator is registered last. This is what makes the declared counter authoritative.
        var real = new Stub(new() { ["solar|" + EnergyPeriod.Metric] = 27.4 });
        var derived = new Stub(new() { ["solar|" + EnergyPeriod.Metric] = 2.76 });

        var composite = new CompositeFlowValueSource(real, derived);

        Assert.True(composite.TryGetValue("solar", EnergyPeriod.Metric, out var v));
        Assert.Equal(27.4, v);
    }

    private sealed class Stub : IFlowValueSource
    {
        private readonly Dictionary<string, double> v;
        public Stub(Dictionary<string, double> x) => v = x;
        public bool TryGetValue(string node, string metric, out double value) => v.TryGetValue(node + "|" + metric, out value);
    }
}
