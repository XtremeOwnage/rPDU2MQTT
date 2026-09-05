using System.Text.Json.Nodes;
using rPDU2MQTT.Core.Flow;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// Each energy direction is named in the words of the thing being measured.
/// <para>
/// The bug this pins: both directions were named relative to the node — "Energy" for what leaves it,
/// "Energy In" for what arrives. For a grid, energy arriving at the grid is what a person calls export, so
/// Home Assistant's picker showed "Energy In · Grid" underneath "Energy exported to grid" and the sensor
/// read as its own opposite. The wiring was right the whole time; only the label lied.
/// </para>
/// </summary>
public class EnergyDirectionNamingTests
{
    private static JsonObject Doc(string kind, bool bidirectional) =>
        FlowExport.DiscoveryDocument(
            new FlowNode("grid", "Grid", kind, 1200), null, "rpdu/energyflow/grid",
            "kWh", "W", null, includeEnergyIn: bidirectional);

    private static string NameOf(JsonObject doc, string suffix) =>
        (string?)doc["components"]![$"energyflow_grid_{suffix}"]!["name"] ?? "";

    [Fact]
    public void AGridSaysImportedAndExported_NotItsOwnOpposite()
    {
        var doc = Doc("grid", bidirectional: true);

        Assert.Equal("Imported", NameOf(doc, "energy"));
        Assert.Equal("Exported", NameOf(doc, "energy_in"));
    }

    [Fact]
    public void ABatterySaysDischargedAndCharged()
    {
        var doc = Doc("battery", bidirectional: true);

        Assert.Equal("Discharged", NameOf(doc, "energy"));
        Assert.Equal("Charged", NameOf(doc, "energy_in"));
    }

    [Fact]
    public void AOneWayNodeIsStillJustEnergy()
    {
        // Solar only ever produces. "Imported" would be nonsense and "Energy" is what it has always been —
        // renaming it would rewrite a friendly name for no gain.
        Assert.Equal("Energy", NameOf(Doc("solar", bidirectional: false), "energy"));
        Assert.Equal("Energy", NameOf(Doc("node", bidirectional: false), "energy"));
    }

    [Fact]
    public void AKindWithNoWordsOfItsOwn_KeepsTheGenericPair()
    {
        var doc = Doc("node", bidirectional: true);

        Assert.Equal("Energy", NameOf(doc, "energy"));
        Assert.Equal("Energy In", NameOf(doc, "energy_in"));
    }

    [Fact]
    public void TheUniqueIdsAreUntouched_SoNothingLosesItsHistory()
    {
        // The whole reason this is safe to change: entity_id and recorded statistics key off unique_id.
        var doc = Doc("grid", bidirectional: true);
        var ids = doc["components"]!.AsObject().Select(kv => (string?)kv.Value!["unique_id"]).ToList();

        Assert.Contains("energyflow_grid_energy", ids);
        Assert.Contains("energyflow_grid_energy_in", ids);
    }
}
