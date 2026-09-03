using System.Text.Json.Nodes;
using rPDU2MQTT.Core.Flow;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// Which <c>energy_sources</c> entries on Home Assistant's Energy Dashboard belong to this bridge.
///
/// <para>
/// Reported from a live dashboard: a solar source pointing at <c>sensor.solar_pv_energy (unknown)</c> sat
/// beside the live one. Home Assistant had registered a second entity and suffixed it, and the entry we
/// wrote for the first stopped matching anything we currently produce — so it read as the user's own and
/// was kept. A dead source is only untidy; while both were alive the dashboard counted the same generation
/// twice.
/// </para>
/// </summary>
public class EnergySourceOrphanTests
{
    private static JsonObject Solar(string stat) => new() { ["type"] = "solar", ["stat_energy_from"] = stat };

    private static readonly Dictionary<string, string> Registry = new(StringComparer.OrdinalIgnoreCase)
    {
        // What HA holds: the orphan and the live one both resolve to unique_ids of ours.
        ["sensor.solar_pv_energy"] = "energyflow_eg4_flexboss21_solar_energy",
        ["sensor.solar_pv_energy_2"] = "energyflow_eg4_flexboss21_solar_energy",
        ["sensor.shelly_pv"] = "shellyplug_s_1a2b3c_energy",
    };

    private static Dictionary<string, string> Reverse() => Registry.ToDictionary(k => k.Key, v => v.Value, StringComparer.OrdinalIgnoreCase);

    [Fact]
    public void AnEntryWeAreProducingRightNowIsOurs()
        => Assert.True(EnergyDashboardSync.IsOurs(Solar("sensor.solar_pv_energy_2"), Reverse(),
            new HashSet<string>(["sensor.solar_pv_energy_2"], StringComparer.OrdinalIgnoreCase)));

    /// <summary>The orphan. Nothing we publish points at it any more, but the entity is still ours.</summary>
    [Fact]
    public void AnEntryWeUsedToProduceIsStillOurs()
        => Assert.True(EnergyDashboardSync.IsOurs(Solar("sensor.solar_pv_energy"), Reverse(),
            new HashSet<string>(["sensor.solar_pv_energy_2"], StringComparer.OrdinalIgnoreCase)));

    /// <summary>Somebody else's sensor is left exactly where they put it.</summary>
    [Fact]
    public void SomeoneElsesEntryIsNotOurs()
        => Assert.False(EnergyDashboardSync.IsOurs(Solar("sensor.shelly_pv"), Reverse(),
            new HashSet<string>(["sensor.solar_pv_energy_2"], StringComparer.OrdinalIgnoreCase)));

    /// <summary>A stat that resolves to nothing at all says nothing about us — leave it alone.</summary>
    [Fact]
    public void AnUnresolvableEntryIsNotClaimed()
        => Assert.False(EnergyDashboardSync.IsOurs(Solar("sensor.something_deleted"), Reverse(),
            new HashSet<string>([], StringComparer.OrdinalIgnoreCase)));

    /// <summary>A grid entry is flat (stat_energy_from/to), and both halves count toward ownership.</summary>
    [Fact]
    public void AGridEntrysReturnLaneAlsoIdentifiesIt()
    {
        var grid = new JsonObject
        {
            ["type"] = "grid",
            ["flow_from"] = new JsonArray(new JsonObject { ["stat_energy_from"] = "sensor.solar_pv_energy" }),
        };
        Assert.True(EnergyDashboardSync.IsOurs(grid, Reverse(), new HashSet<string>([], StringComparer.OrdinalIgnoreCase)));
    }
}
