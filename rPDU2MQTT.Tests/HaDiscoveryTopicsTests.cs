using rPDU2MQTT.Core.HomeAssistant;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// "Clear discovery" has to mean the broker is clean. It used to mean "clear what this process published
/// since it started", which left every config from an earlier version, a changed config, or the energy-flow
/// exporter's separate bookkeeping in place — and in Home Assistant forever.
/// </summary>
public class HaDiscoveryTopicsTests
{
    private static readonly string[] Retained =
    [
        "homeassistant/device/rPDU2MQTT_A0AE_outlets_4/config",       // ours, device layout
        "homeassistant/device/energyflow_grid/config",                // ours, flow tier
        "homeassistant/sensor/rPDU2MQTT_A0AE_energy/config",          // ours, legacy per-entity layout
        "homeassistant/binary_sensor/energyflow_old_alarm/config",    // ours, legacy, different component
        "homeassistant/sensor/node1/rPDU2MQTT_A0AE_x/config",         // ours, node-scoped layout
        "homeassistant/sensor/acurite_attic/config",                  // someone else entirely
        "homeassistant/device/zigbee_0x00124b/config",                // someone else entirely
        "Rack_PDU/pdu_1/outlets/4/realpower",                         // not discovery
        "homeassistant/device/energyflow_grid/state",                 // ours, but not a config topic
    ];

    [Fact]
    public void EverythingOfOursIsFound_WhicheverLayoutItWasPublishedIn()
    {
        var owned = HaDiscoveryTopics.Owned(Retained, "homeassistant");

        Assert.Equal(new[]
        {
            "homeassistant/device/rPDU2MQTT_A0AE_outlets_4/config",
            "homeassistant/device/energyflow_grid/config",
            "homeassistant/sensor/rPDU2MQTT_A0AE_energy/config",
            "homeassistant/binary_sensor/energyflow_old_alarm/config",
            "homeassistant/sensor/node1/rPDU2MQTT_A0AE_x/config",
        }, owned);
    }

    [Fact]
    public void NobodyElsesDiscoveryIsEverTouched()
    {
        // The failure that would matter: clearing another integration's config deletes their devices out of
        // Home Assistant, and nothing here would put them back.
        var owned = HaDiscoveryTopics.Owned(Retained, "homeassistant");

        Assert.DoesNotContain(owned, t => t.Contains("acurite"));
        Assert.DoesNotContain(owned, t => t.Contains("zigbee"));
    }

    [Fact]
    public void OnlyConfigTopics_NotStateTopics()
        => Assert.DoesNotContain(HaDiscoveryTopics.Owned(Retained, "homeassistant"), t => t.EndsWith("/state"));

    [Fact]
    public void ACustomPrefixIsHonoured()
    {
        var retained = new[] { "ha/device/energyflow_x/config", "homeassistant/device/energyflow_x/config" };
        Assert.Equal(new[] { "ha/device/energyflow_x/config" }, HaDiscoveryTopics.Owned(retained, "ha"));
    }

    [Fact]
    public void ABlankPrefixMatchesNothingRatherThanEverything()
    {
        Assert.Empty(HaDiscoveryTopics.Owned(Retained, ""));
        Assert.Empty(HaDiscoveryTopics.Owned(Retained, "  "));
        Assert.Empty(HaDiscoveryTopics.Owned(Retained, null));
    }

    [Fact]
    public void AnIdThatMerelyContainsOurNameIsNotOurs()
    {
        // Ownership is a prefix, not a substring — someone else's "solar_rPDU2MQTT_mirror" is not ours to delete.
        var retained = new[] { "homeassistant/sensor/solar_rPDU2MQTT_mirror/config" };
        Assert.Empty(HaDiscoveryTopics.Owned(retained, "homeassistant"));
    }
}
