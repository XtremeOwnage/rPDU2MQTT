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
        // Call the carry-over directly. The first version started the service and slept, which passed
        // locally and failed on a slower CI runner — a race, not a test.
        Assert.Equal(1, svc.LoadTotals());

        Assert.True(svc.TryGetValue("solar", "energy", out var v));
        Assert.Equal(42.0, v);   // carried over, not restarted at 0
    }

    /// <summary>A snapshot cache holding one PDU whose outlet counter the test moves.</summary>
    private sealed class OnePdu : rPDU2MQTT.Core.ISnapshotCache
    {
        private readonly Models.PDU.Measurement m = new() { Type = "energy", Value = "0", Units = "kWh" };
        private readonly rPDU2MQTT.Core.PduSnapshot snap;

        public OnePdu()
        {
            var outlet = new Models.PDU.Outlet { Key = 3, Entity_Name = "o3", Entity_DisplayName = "Kube05" };
            outlet.Measurements.Add(m);
            var device = new Models.PDU.Device { Key = "rack_pdu_1", Entity_Name = "rack_pdu_1", Entity_DisplayName = "Rack-PDU-1" };
            device.Outlets.Add(outlet);
            var data = new Models.PDU.PduData();
            data.Devices.Add(device);
            snap = new rPDU2MQTT.Core.PduSnapshot("i1", DateTime.UtcNow, data);
        }

        public void Reads(double kWh) => m.Value = kWh.ToString(System.Globalization.CultureInfo.InvariantCulture);
        public rPDU2MQTT.Core.PduSnapshot? Latest => snap;
        public rPDU2MQTT.Core.PduSnapshot? Get(string instanceId) => snap;
        public IReadOnlyCollection<rPDU2MQTT.Core.PduSnapshot> All => new[] { snap };
    }

    private static Config PeriodConfig()
    {
        var c = new Config();
        c.EnergyFlow.Aggregation.Enabled = false;        // integration off: periods must not depend on it
        c.EnergyFlow.Aggregation.TrackPeriods = true;
        c.EnergyFlow.Aggregation.PeriodTimeZone = "UTC";
        return c;
    }

    [Fact]
    public void AnOutletsDailyTotal_IsTheRiseOfItsOwnCounter_NotItsLifetimeFigure()
    {
        // The PDU arrives mid-life reading 7,371 kWh. Publishing that as "today" is what put a lifetime
        // figure next to a freshly-derived one and produced a panel eleven times its own feeder.
        var pdus = new OnePdu();
        var svc = new EnergyAggregationService(PeriodConfig(), new Fixed(), new MemoryEnergyStore(), pdus);
        var t0 = new DateTime(2026, 8, 1, 8, 0, 0, DateTimeKind.Utc);

        pdus.Reads(7371.006);
        svc.Sample(TimeSpan.FromMinutes(2), t0);
        Assert.True(svc.TryGetValue("outlet:rack_pdu_1:3", EnergyPeriod.Metric, out var first));
        Assert.Equal(0, first);            // first sighting establishes a mark, it does not claim energy

        pdus.Reads(7375.506);
        svc.Sample(TimeSpan.FromMinutes(2), t0.AddHours(4));
        Assert.True(svc.TryGetValue("outlet:rack_pdu_1:3", EnergyPeriod.Metric, out var today));
        Assert.Equal(4.5, today, 6);
    }

    [Fact]
    public void TheDailyTotal_RestartsAtMidnight_WhileTheOutletsOwnCounterRunsOn()
    {
        var pdus = new OnePdu();
        var svc = new EnergyAggregationService(PeriodConfig(), new Fixed(), new MemoryEnergyStore(), pdus);

        pdus.Reads(100);
        svc.Sample(TimeSpan.FromMinutes(2), new DateTime(2026, 8, 1, 20, 0, 0, DateTimeKind.Utc));
        pdus.Reads(110);
        svc.Sample(TimeSpan.FromMinutes(2), new DateTime(2026, 8, 1, 23, 0, 0, DateTimeKind.Utc));
        Assert.True(svc.TryGetValue("outlet:rack_pdu_1:3", EnergyPeriod.Metric, out var beforeMidnight));
        Assert.Equal(10, beforeMidnight, 6);

        pdus.Reads(112);
        svc.Sample(TimeSpan.FromMinutes(2), new DateTime(2026, 8, 2, 1, 0, 0, DateTimeKind.Utc));
        Assert.True(svc.TryGetValue("outlet:rack_pdu_1:3", EnergyPeriod.Metric, out var newDay));
        Assert.Equal(2, newDay, 6);        // the new day counts only what has accrued since it began
    }

    [Fact]
    public void WithPeriodsOff_NothingIsTracked_AndTheLifetimeMetricIsUnaffected()
    {
        var pdus = new OnePdu();
        var cfg = PeriodConfig();
        cfg.EnergyFlow.Aggregation.TrackPeriods = false;
        var svc = new EnergyAggregationService(cfg, new Fixed(), new MemoryEnergyStore(), pdus);

        pdus.Reads(7371.006);
        svc.Sample(TimeSpan.FromMinutes(2), new DateTime(2026, 8, 1, 8, 0, 0, DateTimeKind.Utc));

        Assert.False(svc.TryGetValue("outlet:rack_pdu_1:3", EnergyPeriod.Metric, out _));
        Assert.False(svc.TryGetValue("outlet:rack_pdu_1:3", "energy", out _));
    }

    [Fact]
    public void ANodeBoundToARealEnergyCounter_StillGetsADailyTotal()
    {
        // The case the whole thing turns on. Solar Assistant publishes the inverter's cumulative kWh, so the
        // node was never integrated and had no state at all — it kept its lifetime figure and went on
        // disagreeing with the PDUs by a factor of eleven. Its rise is re-based like any other counter.
        var cfg = PeriodConfig();
        cfg.EnergyFlow.Nodes.Add(new EnergyFlowNode { Id = "flexboss" });
        var live = new Fixed();
        var svc = new EnergyAggregationService(cfg, live, new MemoryEnergyStore());
        var t0 = new DateTime(2026, 8, 1, 8, 0, 0, DateTimeKind.Utc);

        live.Values[("flexboss", "energy")] = 740;
        svc.Sample(TimeSpan.FromMinutes(2), t0);
        live.Values[("flexboss", "energy")] = 752.5;
        svc.Sample(TimeSpan.FromMinutes(2), t0.AddHours(6));

        Assert.True(svc.TryGetValue("flexboss", EnergyPeriod.Metric, out var today));
        Assert.Equal(12.5, today, 6);

        // And its lifetime figure is left to the source that actually measures it — offering our re-based
        // total as `energy` would hand Home Assistant a number 740 kWh below the meter it came from.
        Assert.False(svc.TryGetValue("flexboss", "energy", out _));
    }

    [Fact]
    public void TheReturnLane_GetsItsOwnDailyTotal_RatherThanNettingOffTheSupply()
    {
        // A battery charging and a battery discharging are two quantities, not one signed one. Folding them
        // together would make a day of heavy cycling look like a quiet one.
        var cfg = PeriodConfig();
        cfg.EnergyFlow.Nodes.Add(new EnergyFlowNode { Id = "battery", Kind = "battery" });
        var live = new Fixed();
        var svc = new EnergyAggregationService(cfg, live, new MemoryEnergyStore());
        var t0 = new DateTime(2026, 8, 1, 8, 0, 0, DateTimeKind.Utc);

        live.Values[("battery", "energy")] = 26.1;
        live.Values[("battery", "energy#in")] = 32.2;
        svc.Sample(TimeSpan.FromMinutes(2), t0);
        live.Values[("battery", "energy")] = 28.1;
        live.Values[("battery", "energy#in")] = 35.2;
        svc.Sample(TimeSpan.FromMinutes(2), t0.AddHours(3));

        Assert.True(svc.TryGetValue("battery", EnergyPeriod.Metric, out var discharged));
        Assert.True(svc.TryGetValue("battery", "energytoday#in", out var charged));
        Assert.Equal(2, discharged, 6);
        Assert.Equal(3, charged, 6);
    }

    [Fact]
    public void WithIntegrationOff_ADerivedLifetimeTotal_IsNotOffered()
    {
        // Periods default on; integration stays opt-in because it IS an estimate. Tracking one must not
        // quietly switch on the other.
        var cfg = PeriodConfig();
        cfg.EnergyFlow.Nodes.Add(new EnergyFlowNode { Id = "inverter" });
        var live = new Fixed();
        live.Values[("inverter", "realpower")] = 1000;

        var svc = new EnergyAggregationService(cfg, live, new MemoryEnergyStore());
        var t0 = new DateTime(2026, 8, 1, 8, 0, 0, DateTimeKind.Utc);
        svc.Sample(TimeSpan.FromMinutes(2), t0);
        svc.Sample(TimeSpan.FromMinutes(2), t0.AddMinutes(1));

        Assert.False(svc.TryGetValue("inverter", "energy", out _));
    }
}
