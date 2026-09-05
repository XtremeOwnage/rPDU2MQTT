using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Core.Integrations;
using rPDU2MQTT.Integrations.EmonCms;
using rPDU2MQTT.Models.Config;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// A withheld binding is reported by the ingest that withheld it, and by no other.
/// <para>
/// The bug this pins: the period audit is one shared object, and every ingest that consulted it published
/// its whole list as its own. Two withheld bindings — one EmonCMS feed, one MQTT topic — rendered as four
/// rows, each appearing once per ingest, and the alert that counted "2 withheld" then listed four.
/// </para>
/// </summary>
public class WithheldOncePerIngestTests
{
    private static readonly DateTime Now = new(2026, 9, 5, 12, 0, 0, DateTimeKind.Utc);

    /// <summary>An audit holding entries from several ingests, as the real one does.</summary>
    private sealed class SharedAudit : IPeriodAuditor
    {
        public List<WithheldSource> Held { get; } = new();
        public bool Allow(string nodeId, string source, string? direction, string periodKey, double value)
        {
            // Refuse everything: this test is about who reports it, not about the audit's own rules.
            if (!Held.Any(w => w.Source == source))
                Held.Add(new WithheldSource(nodeId, source, "energytoday", "did not reset at the rollover"));
            return false;
        }
        public IReadOnlyCollection<WithheldSource> Withheld => Held;
    }

    [Fact]
    public void AnIngestReportsOnlyTheBindingsItAudited()
    {
        var audit = new SharedAudit();
        // Something else — the MQTT ingest — already withheld a topic against the same audit.
        audit.Held.Add(new WithheldSource("coffee_pot", "esphome/devices/coffee-pot/sensor/energy_d/state",
                                          "energytoday", "did not reset at the rollover"));

        var cfg = new Config();
        cfg.EnergyFlow.Nodes.Add(new EnergyFlowNode
        {
            Id = "main_panel",
            Sources = [new EnergyFlowSource { Type = "emoncms", Metric = "energy", Accumulation = "period",
                                              Feed = "Main Panel Energy Daily" }],
        });
        var emon = new EmonCmsValueSource(cfg, null, audit);
        emon.Bind(SourceBindings.For(cfg, "emoncms"));
        emon.Apply([new EmonCmsFeed("7", "Main Panel Energy Daily", "IotaWatt", "kWh", 1.287, Now)], Now);

        var reported = ((IWithheldSources)emon).Withheld;

        // Its own feed, once.
        Assert.Equal("EmonCMS feed 'Main Panel Energy Daily'", Assert.Single(reported).Source);
        // And not the MQTT ingest's topic, which it never audited.
        Assert.DoesNotContain(reported, w => w.Source.StartsWith("esphome/"));
    }

    [Fact]
    public void TheSameBindingIsNotCountedTwice()
    {
        var audit = new SharedAudit();
        var cfg = new Config();
        cfg.EnergyFlow.Nodes.Add(new EnergyFlowNode
        {
            Id = "main_panel",
            Sources = [new EnergyFlowSource { Type = "emoncms", Metric = "energy", Accumulation = "period",
                                              Feed = "Main Panel Energy Daily" }],
        });
        var emon = new EmonCmsValueSource(cfg, null, audit);
        emon.Bind(SourceBindings.For(cfg, "emoncms"));

        // Polled repeatedly, as it is in life.
        for (var i = 0; i < 3; i++)
            emon.Apply([new EmonCmsFeed("7", "Main Panel Energy Daily", "IotaWatt", "kWh", 1.287, Now)], Now);

        Assert.Single(((IWithheldSources)emon).Withheld);
    }

    [Fact]
    public void AnIngestThatAuditedNothing_ReportsNothingFromTheSharedAudit()
    {
        var audit = new SharedAudit();
        audit.Held.Add(new WithheldSource("coffee_pot", "esphome/devices/coffee-pot/sensor/energy_d/state",
                                          "energytoday", "did not reset at the rollover"));

        var cfg = new Config();
        var emon = new EmonCmsValueSource(cfg, null, audit);
        emon.Bind(SourceBindings.For(cfg, "emoncms"));

        Assert.Empty(((IWithheldSources)emon).Withheld);
    }
}
