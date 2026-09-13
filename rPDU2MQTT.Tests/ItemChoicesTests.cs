using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Services.Gui;
using Xunit;

using rPDU2MQTT.Integrations.Prometheus;

namespace rPDU2MQTT.Tests;

/// <summary>
/// Collections whose items have a closed set of answers say so.
///
/// <para>
/// A list's element and a dictionary's value have no property to annotate, so both were free text: a
/// Prometheus label the exporter does not produce, or a metric nothing rolls up, was accepted silently and
/// failed only at runtime.
/// </para>
/// </summary>
public class ItemChoicesTests
{
    private static SchemaNode Section(string key) => ConfigSchema.Build().Single(n => n.Key == key);

    [Fact]
    public void PrometheusLabelsOfferTheLabelsTheExporterProduces()
    {
        var labels = Section("Prometheus").Properties!.Single(p => p.Key == "Labels");

        Assert.Equal("enum", labels.ValueSchema!.Type);
        Assert.Contains("device", labels.ValueSchema.EnumValues!);
        Assert.Contains("hierarchy", labels.ValueSchema.EnumValues!);
    }

    [Fact]
    public void AnImportProfilesMetricsOfferEveryMetricThisBuildUnderstands()
    {
        var profiles = Section("MQTT").Properties!.Single(p => p.Key == "ImportProfiles");
        var metrics = profiles.ValueSchema!.Properties!.Single(p => p.Key == "Metrics");

        Assert.Equal("enum", metrics.ValueSchema!.Type);

        // Exactly what a source binding may be, because that is what an import creates. Read from the
        // property that validates a binding, so the offer and the rule cannot drift.
        var bindable = ConfigSchema.Build().Single(n => n.Key == "EnergyFlow")
            .Properties!.Single(p => p.Key == "Nodes")
            .ValueSchema!.Properties!.Single(p => p.Key == "Sources")
            .ValueSchema!.Properties!.Single(p => p.Key == "Metric").EnumValues!;

        // Plus the daily metric: a profile names it to say the device zeroes this counter each day, which
        // the import turns into energy with a period counter.
        Assert.Equal([.. bindable.Where(v => v != ""), "energy_d"], metrics.ValueSchema.EnumValues);
        // A binding itself still cannot be energy_d — that is derived from a counter's rise, not published.
        Assert.DoesNotContain("energy_d", bindable);
        Assert.Contains("energy_d", FlowUnits.Metrics);
    }

    [Fact]
    public void TheChoicesAreTheMetricsThatActuallyResolve()
    {
        Assert.All(FlowUnits.Metrics, m => Assert.NotNull(FlowUnits.Canonical(m)));
        Assert.Contains("realpower", FlowUnits.Metrics);
        Assert.Contains("soc", FlowUnits.Metrics);
    }

    [Fact]
    public void APlainCollectionIsStillFreeText()
    {
        // The attribute is opt-in: a list of arbitrary strings (node tags) must not become a dropdown.
        var nodes = Section("EnergyFlow").Properties!.Single(p => p.Key == "Nodes");
        var tags = nodes.ValueSchema!.Properties!.Single(p => p.Key == "Tags");

        Assert.NotEqual("enum", tags.ValueSchema!.Type);
    }
}
