using System.Text.RegularExpressions;
using rPDU2MQTT.Services;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// Units in discovery configs (#483). The PDU reports voltage as <c>Vrms</c>, which Home Assistant refuses
/// against <c>device_class: voltage</c> — every outlet lost its voltage sensor to it.
/// </summary>
public class HomeAssistantUnitTests
{
    [Theory]
    [InlineData("Vrms", "V")]
    [InlineData("vrms", "V")]
    [InlineData("VRMS", "V")]
    [InlineData(" Vrms ", "V")]
    [InlineData("mVrms", "mV")]
    [InlineData("kVrms", "kV")]
    [InlineData("Arms", "A")]
    [InlineData("mArms", "mA")]
    public void AUnitHomeAssistantRefuses_IsPublishedInTheSpellingItTakes(string reported, string published)
        => Assert.Equal(published, HomeAssistantUnits.ForDiscovery(reported));

    [Theory]
    [InlineData("V")]
    [InlineData("A")]
    [InlineData("W")]
    [InlineData("VA")]
    [InlineData("kWh")]
    [InlineData("Hz")]
    [InlineData("%")]
    [InlineData("°C")]
    public void AUnitItAlreadyTakes_IsLeftAlone(string unit)
        => Assert.Equal(unit, HomeAssistantUnits.ForDiscovery(unit));

    [Theory]
    [InlineData("PF")]
    [InlineData("widgets")]
    public void AUnitWithNoRewrite_IsPublishedAsTheDeviceWroteIt(string unit)
        // An unknown unit is better than a wrong one: Home Assistant only refuses what it knows is wrong for
        // the device class, and blanking it would lose what the device actually said.
        => Assert.Equal(unit, HomeAssistantUnits.ForDiscovery(unit));

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void NothingToPublish_StaysNothing(string? unit)
        => Assert.Equal(unit, HomeAssistantUnits.ForDiscovery(unit));

    /// <summary>
    /// Every unit discovery publishes goes through the rewrite. Both entity types carry one — a sensor's
    /// measurement unit and a writable number's — and the sensor one is what #483 was: the device's spelling
    /// passed straight into the config.
    /// </summary>
    [Fact]
    public void DiscoveryPublishesNoUnitWithoutTranslatingIt()
    {
        var source = File.ReadAllText(Path.Combine(FindRepoRoot(), "rPDU2MQTT.Engine", "Services", "baseTypes", "baseDiscoveryService.cs"));
        var assignments = Regex.Matches(source, @"UnitOfMeasurement\s*=\s*(?<value>[^,\r\n]+)", RegexOptions.None, TimeSpan.FromSeconds(5));

        Assert.True(assignments.Count >= 2, $"Expected discovery to set a unit for sensors and numbers; found {assignments.Count}.");
        var raw = assignments
            .Select(m => m.Groups["value"].Value.Trim())
            .Where(v => !v.StartsWith("HomeAssistantUnits.ForDiscovery("))
            .ToList();

        Assert.True(raw.Count == 0,
            "These discovery units are published in the device's own spelling, which Home Assistant may refuse "
            + $"(#483): {string.Join(", ", raw)}. Wrap them in HomeAssistantUnits.ForDiscovery(...).");
    }

    private static string FindRepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "rPDU2MQTT.sln")))
            dir = dir.Parent;
        return dir?.FullName ?? throw new InvalidOperationException("Could not locate the repository root (no rPDU2MQTT.sln above the test output).");
    }
}
