using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Core.Integrations;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Classes;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// A withheld binding says which ingest is holding it back.
/// <para>
/// The Overview page shows one alert per integration. Without attribution it can report "2 of 46 binding(s)
/// withheld" and then, asked which two, only offer every withheld binding on the bridge — including a
/// Modbus register under a card about MQTT. The count and the list have to agree, or the list is just a
/// second way of not answering.
/// </para>
/// </summary>
public class WithheldAttributionTests
{
    /// <summary>An ingest that withholds and knows its own integration id.</summary>
    private sealed class Ingest : IFlowValueSource, IWithheldSources, IIntegration
    {
        private readonly WithheldSource[] held;
        public Ingest(string id, params WithheldSource[] held) { Id = id; this.held = held; }

        public string Id { get; }
        public string DisplayName => Id;
        public IntegrationGroup Group => IntegrationGroup.Integrations;
        public bool Enabled(Config c) => true;

        public IReadOnlyCollection<WithheldSource> Withheld => held;
        public bool TryGetValue(string node, string metric, out double value) { value = 0; return false; }
    }

    /// <summary>One that withholds but is not an integration in its own right.</summary>
    private sealed class Anonymous : IFlowValueSource, IWithheldSources
    {
        private readonly WithheldSource[] held;
        public Anonymous(params WithheldSource[] held) => this.held = held;
        public IReadOnlyCollection<WithheldSource> Withheld => held;
        public bool TryGetValue(string node, string metric, out double value) { value = 0; return false; }
    }

    private static WithheldSource W(string node, string source, string reason = "stale", string integration = "")
        => new(node, source, "energy", reason, integration);

    [Fact]
    public void EachWithheldBinding_NamesTheIngestHoldingItBack()
    {
        var composite = new CompositeFlowValueSource(
            new Ingest("mqtt-source", W("deep_freezer", "esphome/…/energy_d/state")),
            new Ingest("modbus-source", W("main_panel", "unit 1 · register 40088")));

        var byNode = composite.Withheld.ToDictionary(w => w.Node, w => w.Integration);

        Assert.Equal("mqtt-source", byNode["deep_freezer"]);
        Assert.Equal("modbus-source", byNode["main_panel"]);
    }

    [Fact]
    public void AnIngestThatIsNotAnIntegration_IsLeftUnattributed()
    {
        var composite = new CompositeFlowValueSource(new Anonymous(W("solar", "sa/pv_energy")));

        // Empty, not guessed: a card filtering on its own id must not claim this one, and the page shows it
        // rather than dropping it — an unattributed withheld binding is still a withheld binding.
        Assert.Equal("", Assert.Single(composite.Withheld).Integration);
    }

    [Fact]
    public void AnIngestThatAlreadyNamedItself_IsNotOverwritten()
    {
        // A composite of composites must not relabel what an inner one already attributed.
        var inner = new CompositeFlowValueSource(new Ingest("mqtt-source", W("fridge", "esphome/…/energy_d/state")));
        var outer = new CompositeFlowValueSource(new Ingest("modbus-source"), inner);

        var fridge = Assert.Single(outer.Withheld, w => w.Node == "fridge");
        Assert.Equal("mqtt-source", fridge.Integration);
    }

    [Fact]
    public void NothingWithheld_ReportsNothing()
    {
        Assert.Empty(new CompositeFlowValueSource(new Ingest("mqtt-source")).Withheld);
    }
}
