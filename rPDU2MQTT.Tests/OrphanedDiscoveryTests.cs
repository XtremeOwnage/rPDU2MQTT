using rPDU2MQTT.Core.Flow;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// Retained discovery configs outlive what they describe. Home Assistant kept showing an outlet three times
/// because two older configs for it were still sitting on the broker with nothing to remove them.
/// </summary>
public class OrphanedDiscoveryTests
{
    private static readonly string[] Retained =
    [
        "homeassistant/device/energyflow_grid/config",              // current tier — keep
        "homeassistant/device/energyflow_outlet_pdu_1_4/config",    // duplicate of a native outlet — orphan
        "homeassistant/device/energyflow_pdu_pdu_1/config",         // duplicate of a native PDU — orphan
        "homeassistant/device/rPDU2MQTT_A0AE_outlets_4/config",     // native discovery — another service owns it
        "homeassistant/sensor/acurite_attic/config",                // someone else's integration entirely
        "Rack_PDU/pdu_1/outlets/4/realpower",                       // not discovery at all
    ];

    [Fact]
    public void OnlyOurOwnStaleDevicesAreListed()
    {
        var orphans = FlowExport.OrphanedDiscoveryTopics(Retained, new[] { "energyflow_grid" }, "homeassistant");

        Assert.Equal(new[]
        {
            "homeassistant/device/energyflow_outlet_pdu_1_4/config",
            "homeassistant/device/energyflow_pdu_pdu_1/config",
        }, orphans);
    }

    [Fact]
    public void AnotherIntegrationIsNeverTouched()
    {
        // The failure that would matter most: clearing someone else's retained discovery deletes their
        // devices from Home Assistant, and nothing here would put them back.
        var orphans = FlowExport.OrphanedDiscoveryTopics(Retained, System.Array.Empty<string>(), "homeassistant");

        Assert.DoesNotContain(orphans, t => t.Contains("acurite"));
        Assert.DoesNotContain(orphans, t => t.Contains("rPDU2MQTT_"));
        Assert.DoesNotContain(orphans, t => t.StartsWith("Rack_PDU/"));
    }

    [Fact]
    public void EverythingCurrentSurvives()
    {
        var current = new[] { "energyflow_grid", "energyflow_outlet_pdu_1_4", "energyflow_pdu_pdu_1" };
        Assert.Empty(FlowExport.OrphanedDiscoveryTopics(Retained, current, "homeassistant"));
    }

    [Fact]
    public void ACustomDiscoveryPrefixIsHonoured()
    {
        var retained = new[] { "ha/device/energyflow_gone/config", "homeassistant/device/energyflow_gone/config" };

        var orphans = FlowExport.OrphanedDiscoveryTopics(retained, System.Array.Empty<string>(), "ha");

        Assert.Equal(new[] { "ha/device/energyflow_gone/config" }, orphans);
    }

    [Fact]
    public void ABlankPrefixClearsNothing()
    {
        // A misconfigured prefix must not turn into "match everything and delete it".
        Assert.Empty(FlowExport.OrphanedDiscoveryTopics(Retained, System.Array.Empty<string>(), ""));
        Assert.Empty(FlowExport.OrphanedDiscoveryTopics(Retained, System.Array.Empty<string>(), "   "));
    }

    [Fact]
    public void MalformedTopicsAreIgnoredRatherThanGuessedAt()
    {
        var retained = new[]
        {
            "homeassistant/device/energyflow_x/config/extra",
            "homeassistant/device/energyflow_x",
            "homeassistant/energyflow_x/config",
        };
        Assert.Empty(FlowExport.OrphanedDiscoveryTopics(retained, System.Array.Empty<string>(), "homeassistant"));
    }
}
